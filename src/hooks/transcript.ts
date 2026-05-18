/**
 * Transcript reader for token-density-based capture-reminder scheduling.
 *
 * Claude Code records each session as JSONL at
 *   ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl
 * with one record per turn (user message, agent message, tool call, tool
 * result). Each record's `.message.content` (or `.content`, depending on
 * Claude Code version) contains the actual conversation material.
 *
 * For capture-reminder scheduling we need a single number: total estimated
 * tokens of "material to extract decisions from" across the session so far.
 * We deliberately use the same 4-chars-per-token estimator as
 * `budget.ts:estimateTokens` — drift-free with the rest of the hook surface.
 *
 * IO discipline (Constitution III):
 *   - Path missing / unreadable → return null (caller falls back to legacy
 *     turn-based check)
 *   - JSONL parse error on a single line → skip that line, keep going
 *   - Never throw to the hook process
 */

import { stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { estimateTokens } from './budget.js';

export interface TranscriptTokenInfo {
  /** Estimated total tokens across all extractable text in the transcript. */
  totalTokens: number;
  /** Current transcript file size in bytes — used by the hybrid scheduler. */
  totalBytes: number;
}

/**
 * Recursively walk a JSON value and collect every string we find. Claude
 * Code's transcript format has evolved; some records nest content inside
 * `{role, content: [{type: 'text', text: '...'}]}`, others have flat
 * `{message: {content: '...'}}`, others wrap tool data in
 * `{input: {...query/path/text...}}`. Rather than chase the schema across
 * versions and tool shapes, we descend selectively at top level (filtering
 * out IDs / timestamps / model names) and then walk all strings inside.
 *
 * Token-budget perspective: occasional noise strings (e.g., a few-char
 * "type" values) are 1-2 tokens — negligible against typical exchange
 * totals of 500-5000 tokens.
 */
const TOP_LEVEL_CONTENT_KEYS = new Set([
  'content',
  'text',
  'message',
  'input',
  'output',
  'tool_use_result',
  'tool_use',
  'result',
]);

function collectTextFromRecord(record: unknown): string {
  const acc: string[] = [];
  const visited = new WeakSet<object>();

  function walkAll(v: unknown): void {
    if (typeof v === 'string') {
      acc.push(v);
      return;
    }
    if (!v || typeof v !== 'object') return;
    if (visited.has(v as object)) return;
    visited.add(v as object);

    if (Array.isArray(v)) {
      for (const item of v) walkAll(item);
      return;
    }

    // Once we've entered a content-bearing block, all nested strings count.
    for (const val of Object.values(v as Record<string, unknown>)) {
      walkAll(val);
    }
  }

  function walkTopLevel(v: unknown): void {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return;
    for (const [key, val] of Object.entries(v as Record<string, unknown>)) {
      if (TOP_LEVEL_CONTENT_KEYS.has(key)) {
        walkAll(val);
      }
    }
  }

  walkTopLevel(record);
  return acc.join('\n');
}

/**
 * Read the JSONL transcript at `path` line-by-line and accumulate token
 * estimate. Streams the file so multi-megabyte transcripts don't pin all
 * content in memory. Returns null on any IO failure.
 */
export async function readTranscriptTokens(
  path: string | undefined,
): Promise<TranscriptTokenInfo | null> {
  if (!path) return null;

  let totalBytes: number;
  try {
    const st = await stat(path);
    totalBytes = st.size;
  } catch {
    return null;
  }

  if (totalBytes === 0) {
    return { totalTokens: 0, totalBytes: 0 };
  }

  let collected = '';
  try {
    const rl = createInterface({
      input: createReadStream(path, { encoding: 'utf-8' }),
      crlfDelay: Infinity,
    });
    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line) as unknown;
        const text = collectTextFromRecord(record);
        if (text) collected += text + '\n';
      } catch {
        // Single malformed line — skip, keep streaming the rest.
      }
    }
  } catch {
    return null;
  }

  return {
    totalTokens: estimateTokens(collected),
    totalBytes,
  };
}
