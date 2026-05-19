/**
 * `valis hook capture-done` — local CLI command invoked by the agent
 * via the Bash tool after it has finished writing decisions to Valis
 * (v0.5.2 block-and-gate flow).
 *
 * Why CLI subcommand, not MCP tool: MCP tools in plugin mode run on
 * the Vercel backend; they cannot write to the user's local
 * `~/.valis/capture-sentinels/` directory. The pre-compact hook needs
 * the sentinel locally to decide allow/block. A CLI subcommand
 * sidesteps this entirely: regardless of whether the MCP path is
 * stdio or HTTP, the CLI always runs on the user's machine and can
 * write local files. The agent invokes it via the `Bash` tool that
 * Claude Code provides natively.
 *
 * Contract:
 *   - CLAUDE_SESSION_ID must be present in env (Claude Code injects it
 *     for all hook subprocesses + Bash tool runs by default).
 *   - Stored count and note are optional flags carried by argv.
 *   - On success: writes the sentinel atomically and emits a brief
 *     confirmation to stdout. Exits 0.
 *   - On failure (no session_id, write failure): emits a diagnostic
 *     line to stderr and exits 0 anyway. The PreCompact hook is the
 *     enforcement point — if the sentinel is missing it'll just block
 *     again, which is safe.
 */

import { record } from './telemetry.js';
import {
  createSentinel,
  pruneOldSentinels,
  type CaptureSentinel,
} from './sentinels.js';
import { findProjectMarker } from '../config/project.js';
import { loadHookGlobalConfig } from './context.js';

export interface CaptureDoneArgs {
  /** Explicit session_id (overrides CLAUDE_SESSION_ID). Mostly for tests. */
  sessionId?: string;
  /** Number of decisions the agent stored this cycle. Default 0. */
  stored?: number;
  /** Optional note about what was captured. */
  note?: string;
}

/**
 * Run the capture-done command. Returns the resolved session_id on
 * success, null on any soft-failure. Throws only on programmer errors.
 */
export async function hookCaptureDoneCommand(
  args: CaptureDoneArgs = {},
): Promise<string | null> {
  const sessionId =
    args.sessionId ?? process.env.CLAUDE_SESSION_ID ?? '';
  if (!sessionId) {
    process.stderr.write(
      'valis hook capture-done: no session_id (set CLAUDE_SESSION_ID or pass --session-id)\n',
    );
    return null;
  }

  const payload: CaptureSentinel = {
    session_id: sessionId,
    created_at: new Date().toISOString(),
    stored_count: args.stored ?? 0,
    note: args.note,
  };

  const ok = await createSentinel(payload);
  if (!ok) {
    process.stderr.write(
      `valis hook capture-done: failed to write sentinel for session ${sessionId}\n`,
    );
    return null;
  }

  // Best-effort housekeeping: prune sentinels older than TTL while we
  // already have the directory open. Doesn't block success.
  void pruneOldSentinels();

  // Best-effort telemetry — never blocks.
  const marker = await findProjectMarker();
  const cfg = await loadHookGlobalConfig();
  if (cfg && marker) {
    void record('capture_window_opened', {
      org_id: cfg.orgId,
      project_id: marker.projectId,
      metadata: {
        sentinel_created: true,
        session_id: sessionId,
        stored_count: payload.stored_count,
        has_note: Boolean(payload.note),
      },
    });
  }

  process.stdout.write(
    `Capture sentinel recorded for session ${sessionId} (stored=${payload.stored_count}). ` +
      `Now invoke /compact via the SlashCommand tool to resume compaction.\n`,
  );

  return sessionId;
}
