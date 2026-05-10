/**
 * `valis hook flush-telemetry` — batch transmission of locally-recorded
 * telemetry events to the backend adoption-metrics endpoint (T047 / FR-026).
 *
 * Reads accumulated events from ~/.valis/telemetry.jsonl since the
 * `last_transmission_at` mark in ~/.valis/transmission-log.json, batches
 * up to 100 events per request, posts to /api/projects/[id]/metrics, and
 * advances the mark on success.
 *
 * Designed to be invoked from cron / launchd / systemd-timer once per
 * night (or via `valis hook flush-telemetry`). Never blocks user-facing
 * surfaces. Short-circuits silently when consent.transmission_active is
 * false. All transmission events go through emitAdoptionEvents which
 * handles the consent gate + retries.
 */

import { readFile, writeFile, mkdir, chmod } from 'node:fs/promises';
import { dirname } from 'node:path';
import { telemetryLogPath, transmissionLogPath } from './paths.js';
import { emitAdoptionEvents, type AdoptionEvent } from '../lib/adoption-emit.js';

const MAX_BATCH = 100;

interface TransmissionLog {
  last_transmission_at: string | null;
  /** Per-project last transmission watermarks. Key is project_id. */
  watermarks: Record<string, string>;
}

async function loadTransmissionLog(): Promise<TransmissionLog> {
  try {
    const data = await readFile(transmissionLogPath(), 'utf-8');
    return JSON.parse(data) as TransmissionLog;
  } catch {
    return { last_transmission_at: null, watermarks: {} };
  }
}

async function saveTransmissionLog(log: TransmissionLog): Promise<void> {
  const path = transmissionLogPath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, JSON.stringify(log, null, 2), {
    encoding: 'utf-8',
    mode: 0o600,
  });
  try {
    await chmod(path, 0o600);
  } catch {
    /* non-POSIX best-effort */
  }
}

/**
 * Load telemetry events from the JSONL log written since `since`.
 * Filters to event types that map onto the backend `adoption_metric_events`
 * closed enum — local-only events (e.g. `hook_failure`, `session_start_self_heal`)
 * are intentionally excluded from transmission. The `session_start_inject`
 * entry is retained here purely to flush historical pre-#172 log lines.
 */
const TRANSMITTABLE: ReadonlySet<string> = new Set([
  'session_start_inject', // → session_started_with_context (rename)
  'prompt_search_served',
  'prompt_search_hit',
  'prompt_search_miss_threshold',
  'prompt_search_miss_budget',
  'migration_offered',
  'migration_accepted',
  'migration_declined',
  'telemetry_consent_accepted',
  'telemetry_consent_declined',
  'telemetry_day_30_continued',
  'telemetry_day_30_stopped',
]);

const RENAME: Record<string, string> = {
  session_start_inject: 'session_started_with_context',
};

interface TelemetryLine {
  ts: string;
  event: string;
  project_id?: string;
  metadata?: Record<string, unknown>;
}

async function readEventsSince(since: string | null): Promise<TelemetryLine[]> {
  let raw: string;
  try {
    raw = await readFile(telemetryLogPath(), 'utf-8');
  } catch {
    return [];
  }
  const lines = raw.split('\n').filter((l) => l.trim().length > 0);
  const cutoff = since ? Date.parse(since) : 0;
  const events: TelemetryLine[] = [];
  for (const line of lines) {
    let parsed: TelemetryLine;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!parsed.event || !TRANSMITTABLE.has(parsed.event)) continue;
    const ts = Date.parse(parsed.ts);
    if (Number.isFinite(cutoff) && Number.isFinite(ts) && ts <= cutoff) continue;
    events.push(parsed);
  }
  return events;
}

export async function hookFlushTelemetryCommand(): Promise<void> {
  const log = await loadTransmissionLog();
  const events = await readEventsSince(log.last_transmission_at);
  if (events.length === 0) return;

  // Group by project_id; events without a project_id are skipped (the
  // backend ingest endpoint is per-project).
  const byProject = new Map<string, TelemetryLine[]>();
  for (const ev of events) {
    if (!ev.project_id) continue;
    if (!byProject.has(ev.project_id)) byProject.set(ev.project_id, []);
    byProject.get(ev.project_id)!.push(ev);
  }

  for (const [projectId, projectEvents] of byProject) {
    // Chunk into <=100 events per POST.
    for (let i = 0; i < projectEvents.length; i += MAX_BATCH) {
      const chunk = projectEvents.slice(i, i + MAX_BATCH);
      const adoptionEvents: AdoptionEvent[] = chunk.map((e) => ({
        event_type: RENAME[e.event] ?? e.event,
        count: 1,
        occurred_at: e.ts,
      }));
      const result = await emitAdoptionEvents(projectId, adoptionEvents);
      if (!result.ok) {
        // Stop early on consent_off / no_auth / no_config — retrying won't help.
        if (
          result.reason === 'consent_off' ||
          result.reason === 'no_config' ||
          result.reason === 'no_auth' ||
          result.reason === 'no_consent_record'
        ) {
          return;
        }
        // network_error / http_error → leave watermark unmoved so the
        // next flush re-attempts the same window.
        return;
      }
    }
    log.watermarks[projectId] = events[events.length - 1].ts;
  }

  log.last_transmission_at = new Date().toISOString();
  await saveTransmissionLog(log);
}
