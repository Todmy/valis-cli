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
