/**
 * `valis hook <event>` — internal subcommands invoked by Claude Code hooks.
 *
 * Phase A active: session-start, user-prompt-submit, post-tool-use.
 * Phase B stubs: pre-tool-use, pre-compact, stop (silent-skip; activate when
 * the corresponding telemetry triggers per research.md R-14).
 *
 * Every handler is wrapped in a Constitution-III safety net at the bin/
 * level: any throw → empty stdout, exit 0. Telemetry records `hook_failure`
 * with `error_message` so issues surface in the logs.
 */

export { hookSessionStartCommand } from '../hooks/session-start-handler.js';
export { hookUserPromptSubmitCommand } from '../hooks/user-prompt-submit-handler.js';
export { hookPostToolUseCommand } from '../hooks/post-tool-use-handler.js';

/** Phase B silent-skip stubs. Registered for plugin compatibility (FR-029). */
export async function hookPreToolUseCommand(): Promise<void> {
  return;
}

export async function hookPreCompactCommand(): Promise<void> {
  return;
}

export async function hookStopCommand(): Promise<void> {
  return;
}
