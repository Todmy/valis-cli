/**
 * Filesystem path resolution for hook artifacts.
 *
 * Uses ~/.valis by default. Tests override via the `VALIS_HOME` env var.
 * (We can't `vi.spyOn` `os.homedir` under ESM — see vitest ESM limitations.)
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

export function valisHome(): string {
  return process.env.VALIS_HOME ?? join(homedir(), '.valis');
}

/**
 * Resolve `~/.claude` with a `CLAUDE_CONFIG_HOME` env override for tests.
 * Default: `<homedir>/.claude` — Claude Code's well-known config dir.
 */
export function claudeHome(): string {
  return process.env.CLAUDE_CONFIG_HOME ?? join(homedir(), '.claude');
}

export function cachePath(orgId: string, projectId: string): string {
  return join(valisHome(), 'cache', orgId, `${projectId}.json`);
}

export function telemetryLogPath(): string {
  return join(valisHome(), 'telemetry.jsonl');
}

export function consentPath(): string {
  return join(valisHome(), 'consent.json');
}

export function migrationManifestPath(projectId: string): string {
  return join(valisHome(), 'migrate-backup', projectId, 'manifest.json');
}

export function migrationBackupRoot(): string {
  return join(valisHome(), 'migrate-backup');
}

export function configPath(): string {
  return join(valisHome(), 'config.json');
}

export function installationIdPath(): string {
  return join(valisHome(), 'installation-id');
}

export function transmissionLogPath(): string {
  return join(valisHome(), 'transmission-log.json');
}

export function sessionMarkerPath(sessionId: string): string {
  return join(valisHome(), 'session-markers', `${sessionId}.json`);
}

export function sessionMarkerDir(): string {
  return join(valisHome(), 'session-markers');
}

/**
 * Capture-done sentinel for the pre-compact block-and-gate flow
 * (v0.5.2). One file per Claude Code session that has signaled capture
 * completion via the `valis_capture_done` MCP tool. PreCompact hook
 * looks for this file: present → allow compaction; absent → block with
 * structured instruction.
 */
export function captureSentinelPath(sessionId: string): string {
  return join(valisHome(), 'capture-sentinels', `${sessionId}.json`);
}

export function captureSentinelDir(): string {
  return join(valisHome(), 'capture-sentinels');
}
