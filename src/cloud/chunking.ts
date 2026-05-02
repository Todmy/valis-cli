/**
 * Decision chunking for multilingual embedding (019/US4).
 *
 * Long decisions exceed the embedding model's input window — for
 * `intfloat/multilingual-e5-large` that's 514 tokens (~2000 chars in EN,
 * less for UA/PL which tokenize denser). We split such decisions into
 * 1500-char chunks with 200-char overlap and upsert one Qdrant point per
 * chunk, all sharing the same parent `decision_id` payload field.
 *
 * Boundary strategy (per Q2 of speckit.clarify Session 2026-05-03):
 *   1. Paragraph-aware — split on `\n\n` first (markdown-friendly)
 *   2. Sentence-aware fallback — split on `\n` if a paragraph alone exceeds
 *      maxChars
 *   3. Hard slice last — guaranteed to never exceed maxChars
 *
 * Search-side dedup groups results by `decision_id` and keeps the max score
 * per parent decision (per Q3).
 */

export interface Chunk {
  text: string;
  index: number;
  total: number;
}

export interface ChunkOptions {
  maxChars?: number;
  overlap?: number;
}

const DEFAULT_MAX_CHARS = 1500;
const DEFAULT_OVERLAP = 200;

/**
 * Split text into overlapping chunks ≤ maxChars. Single-chunk inputs
 * (text ≤ maxChars) return [{text, index: 0, total: 1}] — callers always
 * receive at least one chunk so they can iterate uniformly.
 */
export function chunkText(text: string, opts: ChunkOptions = {}): Chunk[] {
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
  const overlap = opts.overlap ?? DEFAULT_OVERLAP;

  if (overlap >= maxChars) {
    throw new Error(
      `chunkText: overlap (${overlap}) must be < maxChars (${maxChars})`,
    );
  }

  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return [{ text: '', index: 0, total: 1 }];
  }
  if (trimmed.length <= maxChars) {
    return [{ text: trimmed, index: 0, total: 1 }];
  }

  // Tokenize into paragraph-sized units. If a single paragraph itself
  // exceeds maxChars, fall through to sentence-level split for that unit.
  const segments = splitIntoSegments(trimmed, maxChars);

  // Greedily pack segments into chunks, then add overlap to subsequent
  // chunks to preserve boundary context for retrieval.
  const chunks: string[] = [];
  let current = '';
  for (const seg of segments) {
    if (current.length === 0) {
      current = seg;
      continue;
    }
    if (current.length + 2 + seg.length <= maxChars) {
      current = current + '\n\n' + seg;
    } else {
      chunks.push(current);
      current = seg;
    }
  }
  if (current.length > 0) chunks.push(current);

  const withOverlap = applyOverlap(chunks, overlap);

  // Final safety: any chunk still > maxChars after paragraph packing means
  // a single segment overflowed — slice it hard.
  const sliced: string[] = [];
  for (const c of withOverlap) {
    if (c.length <= maxChars) {
      sliced.push(c);
      continue;
    }
    let pos = 0;
    while (pos < c.length) {
      const end = Math.min(pos + maxChars, c.length);
      sliced.push(c.slice(pos, end));
      if (end >= c.length) break;
      pos = end - overlap;
    }
  }

  const total = sliced.length;
  return sliced.map((t, index) => ({ text: t, index, total }));
}

/**
 * Split text into "natural" segments — paragraphs first, then sentences
 * for any paragraph that alone exceeds maxChars. Output segments are
 * already trimmed; empty results are dropped.
 */
function splitIntoSegments(text: string, maxChars: number): string[] {
  const out: string[] = [];
  const paragraphs = text.split(/\n\s*\n+/).map((p) => p.trim()).filter(Boolean);
  for (const p of paragraphs) {
    if (p.length <= maxChars) {
      out.push(p);
      continue;
    }
    // Paragraph too big — split on sentences. We use line breaks first
    // (markdown lists / numbered points) then `. ` / `! ` / `? ` to keep
    // multilingual punctuation safe (UA/PL share these terminators).
    const lines = p.split(/\n+/).map((l) => l.trim()).filter(Boolean);
    for (const line of lines) {
      if (line.length <= maxChars) {
        out.push(line);
        continue;
      }
      // Try sentence-terminator splitting first.
      const sentences = line.match(/[^.!?]+[.!?]+/g);
      // Reject the regex result if it captured <50% of the line — that means
      // there are no real sentence boundaries and the trailing un-matched
      // remainder would be lost. Fall back to the raw line so the final
      // hard-slice loop in chunkText can chop it cleanly.
      const covered = (sentences ?? []).reduce((sum, s) => sum + s.length, 0);
      if (sentences && sentences.length > 0 && covered >= line.length * 0.5) {
        for (const s of sentences) {
          out.push(s.trim());
        }
      } else {
        out.push(line);
      }
    }
  }
  return out.filter(Boolean);
}

/**
 * Prepend the tail of chunk[i-1] to chunk[i] so retrieval hits near a
 * boundary still surface coherent context. Overlap is taken from the
 * trailing edge to preserve forward semantic flow.
 */
function applyOverlap(chunks: string[], overlap: number): string[] {
  if (overlap <= 0 || chunks.length <= 1) return chunks;
  const out: string[] = [chunks[0]];
  for (let i = 1; i < chunks.length; i++) {
    const prev = chunks[i - 1];
    const tail = prev.slice(Math.max(0, prev.length - overlap));
    out.push(tail + ' ' + chunks[i]);
  }
  return out;
}
