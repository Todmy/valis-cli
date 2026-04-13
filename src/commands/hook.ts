/**
 * valis hook gate  — PreToolUse hook: blocks qdrant-find until valis_search was called
 * valis hook flag  — PostToolUse hook: marks valis_search as called this session
 *
 * These are not user-facing commands — they're called by Claude Code hooks
 * registered in ~/.claude/settings.json during `valis init`.
 */

import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

function getFlagPath(): string {
  const sessionId = process.env.CLAUDE_SESSION_ID ?? 'unknown';
  return join(tmpdir(), `valis-searched-${sessionId}`);
}

/**
 * PreToolUse gate: blocks qdrant-find until valis_search has been called.
 * Outputs JSON to stdout for Claude Code hook protocol.
 */
export function hookGateCommand(): void {
  const flagPath = getFlagPath();

  if (existsSync(flagPath)) {
    // valis_search was already called — allow qdrant-find
    process.exit(0);
  }

  // Block qdrant-find and redirect to valis_search
  const response = {
    decision: 'block',
    reason: 'Call valis_search first for team decision recall (architecture, patterns, constraints). After checking Valis, qdrant-find is available for personal session insights.',
  };
  process.stdout.write(JSON.stringify(response));
}

/**
 * PostToolUse flag: marks that valis_search was called this session.
 * Creates a flag file that the gate hook checks.
 */
export function hookFlagCommand(): void {
  const flagPath = getFlagPath();
  writeFileSync(flagPath, String(Date.now()));
  process.exit(0);
}
