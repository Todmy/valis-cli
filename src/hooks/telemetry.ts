/**
 * Local telemetry log — append-only JSONL with size-based rotation.
 *
 * Storage: ~/.valis/telemetry.jsonl
 * Permissions: 0600
 * Rotation: 10 MB per file × 5 generations.
 *
 * Per data-model.md §3 + FR-021. Recording is unconditional (always-on);
 * transmission is gated by TelemetryConsentRecord (see consent.ts when added).
 */

import { appendFile, stat, rename, mkdir, chmod } from 'node:fs/promises';
import { dirname } from 'node:path';
import { telemetryLogPath } from './paths.js';

export type TelemetryEvent =
  | 'session_start_inject'
  | 'session_start_offline_stub'
  | 'session_start_self_heal'
  | 'prompt_search_served'
  | 'prompt_search_hit'
  | 'prompt_search_miss_threshold'
  | 'prompt_search_miss_budget'
  | 'prompt_search_timeout'
  | 'cache_hit'
  | 'cache_hit_stale'
  | 'cache_miss'
  | 'migration_offered'
  | 'migration_accepted'
  | 'migration_declined'
  | 'migration_completed'
  | 'migration_failed'
  | 'telemetry_consent_accepted'
  | 'telemetry_consent_declined'
  | 'telemetry_day_30_continued'
  | 'telemetry_day_30_stopped'
  | 'config_drift_repaired'
  | 'config_drift_user_customized'
  | 'qdrant_index_repaired'
  | 'mcp_entry_repaired'
  | 'installation_id_recovered'
  | 'auto_memory_drift_detected'
  | 'gitignore_blocking_marker'
  | 'cursor_mcp_repaired'
  | 'hook_failure';

export interface TelemetryRecord {
  ts: string;
  event: TelemetryEvent;
  org_id?: string;
  project_id?: string;
  latency_ms?: number;
  relevance_score?: number;
  cache_age_seconds?: number;
  error_message?: string;
  metadata?: Record<string, unknown>;
}

const MAX_BYTES = 10 * 1024 * 1024;
const MAX_GENERATIONS = 5;

export function logPath(): string {
  return telemetryLogPath();
}

export async function rotateIfNeeded(): Promise<void> {
  const path = logPath();
  let size = 0;
  try {
    const s = await stat(path);
    size = s.size;
  } catch {
    return;
  }
  if (size < MAX_BYTES) return;

  // Shift generations: telemetry.jsonl.4 → .5, .3 → .4, ..., .jsonl → .1
  for (let i = MAX_GENERATIONS - 1; i >= 1; i--) {
    try {
      await rename(`${path}.${i}`, `${path}.${i + 1}`);
    } catch {
      /* generation may not exist */
    }
  }
  try {
    await rename(path, `${path}.1`);
  } catch {
    /* race: another process rotated first */
  }
}

export async function record(
  event: TelemetryEvent,
  data: Omit<TelemetryRecord, 'ts' | 'event'> = {},
): Promise<void> {
  const record: TelemetryRecord = {
    ts: new Date().toISOString(),
    event,
    ...data,
  };
  if (record.error_message && record.error_message.length > 500) {
    record.error_message = record.error_message.slice(0, 500);
  }
  const line = `${JSON.stringify(record)}\n`;
  const path = logPath();
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  } catch {
    /* exists */
  }
  await rotateIfNeeded();
  // Use a write that retries on EAGAIN. fs.appendFile is atomic on POSIX
  // for short writes (<= PIPE_BUF). For our single-line records this is safe.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await appendFile(path, line, { encoding: 'utf-8', mode: 0o600 });
      try {
        await chmod(path, 0o600);
      } catch {
        /* non-POSIX best-effort */
      }
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EAGAIN' && attempt < 2) continue;
      // Telemetry must never crash the hook — swallow.
      return;
    }
  }
}
