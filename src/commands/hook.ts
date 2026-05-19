/**
 * `valis hook <event>` — internal subcommands invoked by Claude Code hooks.
 *
 * Phase A active: session-start (self-heal only), user-prompt-submit
 * (per-prompt augmentation).
 *
 * Phase B partial activation: pre-compact (capture-window injection,
 * 2026-05-19). Closes the decision-loss window between the last
 * capture-reminder and compaction — see pre-compact.ts for rationale.
 *
 * Phase B silent-skip stubs: pre-tool-use, stop, post-tool-use. Activate
 * when the corresponding telemetry triggers per research.md R-14.
 *
 * post-tool-use was active in early Phase A for cache invalidation; the
 * cache infrastructure was removed alongside BACKLOG #172 (SessionStart
 * preload deletion), so the hook is back to a silent-skip stub. Plugin
 * settings continue to register it so future revivals (e.g. capture
 * nudge — FR-041) need no plugin-side change.
 *
 * Every handler is wrapped in a Constitution-III safety net at the bin/
 * level: any throw → empty stdout, exit 0. Telemetry records `hook_failure`
 * with `error_message` so issues surface in the logs.
 */

export { hookSessionStartCommand } from '../hooks/session-start-handler.js';
export { hookUserPromptSubmitCommand } from '../hooks/user-prompt-submit-handler.js';
export { hookFlushTelemetryCommand } from '../hooks/flush-telemetry-handler.js';
export { hookPreCompactCommand } from '../hooks/pre-compact-handler.js';
export { hookCaptureDoneCommand } from '../hooks/capture-done-handler.js';

/** Phase B silent-skip stubs. Registered for plugin compatibility (FR-029). */
export async function hookPreToolUseCommand(): Promise<void> {
  return;
}

export async function hookPostToolUseCommand(): Promise<void> {
  return;
}

export async function hookStopCommand(): Promise<void> {
  return;
}
