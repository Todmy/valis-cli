/**
 * 025/T010: LinkExtractor — server-side `depends_on` enrichment for valis_store.
 *
 * The deep module that converts a decision body + a project-bound search
 * function into an ordered list of UUIDs to attach as `depends_on`. The
 * caller (`handleStore`) is responsible for:
 *   - short-circuiting when the agent supplied its own `depends_on` or
 *     `replaces` (the extractor never emits `status: 'skipped'` itself);
 *   - building the `SearchFn` already bound to (org_id, project_id);
 *   - persisting the structured result onto `audit_entries.new_state.auto_links`.
 *
 * Contract: `specs/025-depends-on-enrich/contracts/link-extractor.md`.
 *
 * Non-blocking guarantee (Constitution III): the returned Promise **never
 * rejects**. Timeouts, search errors, and validation failures collapse to
 * `status: 'failed'` so the caller can write the decision regardless and
 * the operator can read the structured failure reason from analytics.
 */

export type SearchFn = (text: string) => Promise<Array<{
  id: string;
  similarity: number;
}>>;

export interface LinkExtractionOptions {
  /** Cosine threshold; default 0.6. Clamped to [0.0, 1.0]. */
  threshold?: number;
  /** Maximum chosen candidates; default 3. Clamped to [1, 10]. */
  maxCandidates?: number;
  /** Hard timeout in ms; default 1500. */
  timeoutMs?: number;
}

export interface LinkExtractionResult {
  chosen: string[];
  candidates: Array<{ id: string; confidence: number }>;
  threshold: number;
  latency_ms: number;
  status: 'ok' | 'skipped' | 'failed';
  reason?: string;
}

const DEFAULT_THRESHOLD = 0.6;
const DEFAULT_MAX_CANDIDATES = 3;
const DEFAULT_TIMEOUT_MS = 1500;
const HARD_CANDIDATE_CAP = 10;

function clampThreshold(input: number | undefined): number {
  const raw = input ?? DEFAULT_THRESHOLD;
  if (!Number.isFinite(raw)) return DEFAULT_THRESHOLD;
  if (raw < 0) {
    console.warn(`[link-extractor] threshold ${raw} clamped to 0`);
    return 0;
  }
  if (raw > 1) {
    console.warn(`[link-extractor] threshold ${raw} clamped to 1`);
    return 1;
  }
  return raw;
}

function clampMaxCandidates(input: number | undefined): number {
  const raw = Math.floor(input ?? DEFAULT_MAX_CANDIDATES);
  if (!Number.isFinite(raw)) return DEFAULT_MAX_CANDIDATES;
  if (raw < 1) {
    console.warn(`[link-extractor] maxCandidates ${input} clamped to 1`);
    return 1;
  }
  if (raw > HARD_CANDIDATE_CAP) {
    console.warn(`[link-extractor] maxCandidates ${input} clamped to ${HARD_CANDIDATE_CAP}`);
    return HARD_CANDIDATE_CAP;
  }
  return raw;
}

function clampTimeout(input: number | undefined): number {
  const raw = input ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(raw) || raw < 0) return 0;
  return raw;
}

function sanitiseReason(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return 'unknown_error';
}

/**
 * Run `search` against `text` with a hard `opts.timeoutMs` budget. Filter the
 * results by `opts.threshold` (defaults to 0.6), cap the `candidates` record
 * at the hard ceiling of 10 (so analytics can measure precision vs recall),
 * and slice `chosen` to `opts.maxCandidates` (defaults to 3).
 *
 * Never rejects. On any failure, returns a `LinkExtractionResult` with
 * `status: 'failed'` and a sanitised `reason`.
 */
export async function extractLinks(
  text: string,
  search: SearchFn,
  opts?: LinkExtractionOptions,
): Promise<LinkExtractionResult> {
  const threshold = clampThreshold(opts?.threshold);
  const maxCandidates = clampMaxCandidates(opts?.maxCandidates);
  const timeoutMs = clampTimeout(opts?.timeoutMs);

  const started = Date.now();

  if (!text || text.trim().length === 0) {
    return {
      chosen: [],
      candidates: [],
      threshold,
      latency_ms: 0,
      status: 'failed',
      reason: 'empty_text',
    };
  }

  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeoutHandle = setTimeout(() => reject(new Error('timeout')), timeoutMs);
  });

  let raw: Awaited<ReturnType<SearchFn>>;
  try {
    raw = await Promise.race([search(text), timeoutPromise]);
  } catch (err) {
    return {
      chosen: [],
      candidates: [],
      threshold,
      latency_ms: Date.now() - started,
      status: 'failed',
      reason: sanitiseReason(err),
    };
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }

  const ordered = [...raw].sort((a, b) => b.similarity - a.similarity);
  const capped = ordered.slice(0, HARD_CANDIDATE_CAP);
  const candidates = capped.map((c) => ({ id: c.id, confidence: c.similarity }));
  const chosen = capped
    .filter((c) => c.similarity >= threshold)
    .slice(0, maxCandidates)
    .map((c) => c.id);

  return {
    chosen,
    candidates,
    threshold,
    latency_ms: Date.now() - started,
    status: 'ok',
  };
}
