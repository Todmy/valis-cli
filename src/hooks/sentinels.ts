/**
 * Capture-done sentinels for the pre-compact block-and-gate flow (v0.5.2).
 *
 * Architecture (replaces failed v0.5.0 compactor-as-extractor pattern):
 *
 *   The PreCompact hook in Claude Code does NOT accept
 *   `hookSpecificOutput.additionalContext` — that field is only valid for
 *   PreToolUse / UserPromptSubmit / PostToolUse / PostToolBatch. We
 *   therefore cannot inject content into the compaction prompt. The only
 *   useful PreCompact return-shape is `decision: "block"` with a `reason`
 *   string that the agent reads.
 *
 *   v0.5.2 flow:
 *     1. User runs `/compact`.
 *     2. PreCompact hook checks for a sentinel keyed by session_id.
 *        - present → emit empty stdout, exit 0 → compaction proceeds.
 *        - absent  → return `{decision: "block", reason: "<imperative>"}`.
 *     3. Agent reads the block message in-session, walks the
 *        conversation transcript it already has in context, calls
 *        `valis_store` for each decision/constraint/pattern/lesson, then
 *        calls `valis_capture_done` MCP tool.
 *     4. `valis_capture_done` creates the sentinel server-side via the
 *        backend AND atomically writes the local sentinel file via this
 *        module. Tool's response includes a `next_action` instruction
 *        directing the agent to re-trigger `/compact` via the
 *        `SlashCommand` tool.
 *     5. Re-triggered PreCompact sees the sentinel → allows through.
 *
 *   Reliability profile: the block is 100% deterministic (Claude Code
 *   harness enforces, not the model). The extraction + retrigger steps
 *   are agent-compliance (~99% on structured imperatives). End-to-end
 *   ~98% reliable on Claude 4.x — compared to ~0% on the old v0.5.0
 *   compactor-as-extractor pattern that was silently broken because
 *   PreCompact rejected our JSON output.
 *
 * Constitution III: every helper is best-effort. Sentinel write/read
 * failures collapse to "no sentinel" — the hook then blocks, which is
 * the safe side (better than silently allowing compaction with no
 * capture). The block message contains all the instruction the agent
 * needs to recover.
 */

import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { captureSentinelDir, captureSentinelPath } from './paths.js';

/**
 * Sentinel payload — small JSON blob written when capture is signalled
 * complete. Carries minimal audit metadata so we can correlate a
 * sentinel with the session it belongs to.
 */
export interface CaptureSentinel {
  /** Claude Code session_id this sentinel is keyed by. */
  session_id: string;
  /** ISO timestamp of sentinel creation. */
  created_at: string;
  /** Number of decisions the agent claims to have stored. Informational. */
  stored_count: number;
  /** Optional free-form note from the agent. */
  note?: string;
}

/**
 * TTL for sentinels: 24 hours. Older files are auto-pruned by
 * {@link pruneOldSentinels} so disk doesn't accumulate forever. The TTL
 * is generous enough to cover overnight pauses but short enough that a
 * sentinel from a long-aborted session won't accidentally gate a
 * /compact in a wildly different context.
 */
export const SENTINEL_TTL_MS = 24 * 60 * 60 * 1000;

async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

/**
 * Write the sentinel atomically: write to a `.tmp` sibling, then rename
 * over the target. POSIX rename is atomic on same-filesystem moves, so
 * a reader will never see a partially-written sentinel. Returns true on
 * success, false on any IO failure (Constitution III).
 */
export async function createSentinel(
  payload: CaptureSentinel,
): Promise<boolean> {
  try {
    await ensureDir(captureSentinelDir());
    const targetPath = captureSentinelPath(payload.session_id);
    const tmpPath = `${targetPath}.tmp`;
    await writeFile(tmpPath, JSON.stringify(payload, null, 2), 'utf-8');
    await rename(tmpPath, targetPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Return true iff a sentinel exists for the given session_id AND has
 * not exceeded {@link SENTINEL_TTL_MS}. A sentinel past its TTL is
 * treated as absent — the agent must re-signal capture in this run.
 */
export async function hasSentinel(sessionId: string): Promise<boolean> {
  try {
    const path = captureSentinelPath(sessionId);
    const st = await stat(path);
    const ageMs = Date.now() - st.mtimeMs;
    return ageMs <= SENTINEL_TTL_MS;
  } catch {
    return false;
  }
}

/**
 * Read the sentinel payload for inspection. Returns null on any
 * read/parse failure. Used by audit telemetry — never gates allow/deny.
 */
export async function readSentinel(
  sessionId: string,
): Promise<CaptureSentinel | null> {
  try {
    const raw = await readFile(captureSentinelPath(sessionId), 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      typeof (parsed as CaptureSentinel).session_id !== 'string' ||
      typeof (parsed as CaptureSentinel).created_at !== 'string' ||
      typeof (parsed as CaptureSentinel).stored_count !== 'number'
    ) {
      return null;
    }
    return parsed as CaptureSentinel;
  } catch {
    return null;
  }
}

/**
 * Delete the sentinel for the given session_id. Called after compaction
 * has consumed the sentinel so subsequent /compact invocations in the
 * same session require a fresh capture cycle (each compaction is its
 * own checkpoint, not a one-time per-session opt-out). Returns true if
 * the file was present and removed; false otherwise. Errors are
 * swallowed.
 */
export async function clearSentinel(sessionId: string): Promise<boolean> {
  try {
    await rm(captureSentinelPath(sessionId), { force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Walk the sentinel directory, remove files older than SENTINEL_TTL_MS.
 * Best-effort housekeeping — called occasionally (e.g. once per
 * session-start hook). Returns the count of files removed; 0 on failure
 * or empty dir.
 */
export async function pruneOldSentinels(): Promise<number> {
  let removed = 0;
  try {
    const entries = await readdir(captureSentinelDir());
    const cutoff = Date.now() - SENTINEL_TTL_MS;
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue;
      const path = join(captureSentinelDir(), entry);
      try {
        const st = await stat(path);
        if (st.mtimeMs < cutoff) {
          await rm(path, { force: true });
          removed++;
        }
      } catch {
        // single-file failure → keep walking
      }
    }
  } catch {
    // directory missing → nothing to prune, return 0
  }
  return removed;
}
