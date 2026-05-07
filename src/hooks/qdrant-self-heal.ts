/**
 * Qdrant payload-index self-heal — closes the BUG #164 class.
 *
 * Qdrant returns ZERO points (not an error) when a filter targets an
 * unindexed payload field. That makes "we forgot to add an index after
 * introducing a new filter field" silent and recurring. The existing
 * `scripts/qdrant-ensure-indexes.mjs` is a one-shot operator script;
 * this module turns the same canonical list into a continuous self-heal
 * with a per-day watermark so it runs at most once a day per machine.
 *
 * Probe: `GET /collections/<name>` → check `payload_schema` keys against
 * the canonical INDEXES list.
 * Repair: `PUT /collections/<name>/index` for any missing field. Idempotent.
 *
 * Checkpoint: SessionStart self-heal pass (gated behind a daily watermark
 * so we don't ping Qdrant every session). Caller can also force-run via
 * `valis admin reindex --check` or similar.
 */

import { readFile, writeFile, mkdir, chmod } from 'node:fs/promises';
import { dirname } from 'node:path';
import { record as recordTelemetry } from './telemetry.js';
import { valisHome } from './paths.js';
import { join } from 'node:path';

export const QDRANT_INDEXES = [
  { field_name: 'org_id', field_schema: 'keyword' },
  { field_name: 'project_id', field_schema: 'keyword' },
  { field_name: 'type', field_schema: 'keyword' },
  { field_name: 'decision_id', field_schema: 'keyword' },
  { field_name: 'chunk_index', field_schema: 'integer' },
  { field_name: 'status', field_schema: 'keyword' },
] as const;

export const QDRANT_COLLECTIONS = ['decisions', 'decisions_v2'] as const;

const WATERMARK_FILE = 'last-qdrant-index-check.json';
const COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24h

type HealOutcome = 'fresh' | 'repaired' | 'cooldown' | 'no_creds' | 'unreachable' | 'collection_absent';

export interface QdrantHealReport {
  collection: string;
  outcome: HealOutcome;
  repaired_fields?: string[];
  notes?: string;
}

interface Watermark {
  last_checked_at: string;
}

function watermarkPath(): string {
  return join(valisHome(), WATERMARK_FILE);
}

async function readWatermark(): Promise<Watermark | null> {
  try {
    const data = await readFile(watermarkPath(), 'utf-8');
    return JSON.parse(data) as Watermark;
  } catch {
    return null;
  }
}

async function writeWatermark(now: Date = new Date()): Promise<void> {
  const path = watermarkPath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, JSON.stringify({ last_checked_at: now.toISOString() }), {
    encoding: 'utf-8',
    mode: 0o600,
  });
  try {
    await chmod(path, 0o600);
  } catch {
    /* non-POSIX */
  }
}

interface CollectionInfo {
  result?: {
    payload_schema?: Record<string, { data_type?: string }>;
  };
}

async function fetchCollectionInfo(
  url: string,
  apiKey: string,
  collection: string,
  timeoutMs = 3000,
): Promise<CollectionInfo | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${url}/collections/${collection}`, {
      headers: { 'api-key': apiKey },
      signal: ctrl.signal,
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as CollectionInfo;
  } finally {
    clearTimeout(t);
  }
}

async function putIndex(
  url: string,
  apiKey: string,
  collection: string,
  field: { field_name: string; field_schema: string },
  timeoutMs = 5000,
): Promise<boolean> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${url}/collections/${collection}/index?wait=true`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'api-key': apiKey },
      body: JSON.stringify(field),
      signal: ctrl.signal,
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}

export interface QdrantHealOptions {
  /** Override `now` for tests. */
  now?: Date;
  /** Skip the daily cooldown (use for explicit `valis admin reindex --check`). */
  force?: boolean;
  /** Override URL/API key (for tests; otherwise read from env). */
  url?: string;
  apiKey?: string;
}

/**
 * Run the Qdrant payload-index heal across all known collections.
 *
 * Defaults are conservative: skip silently when QDRANT_URL/QDRANT_API_KEY
 * are absent (hosted-mode CLI doesn't talk to Qdrant directly), or when
 * the watermark says we already checked within COOLDOWN_MS.
 */
export async function runQdrantHeal(
  options: QdrantHealOptions = {},
): Promise<QdrantHealReport[]> {
  const url = options.url ?? process.env.QDRANT_URL;
  const apiKey = options.apiKey ?? process.env.QDRANT_API_KEY;
  if (!url || !apiKey) {
    return [{ collection: 'all', outcome: 'no_creds' }];
  }

  if (!options.force) {
    const watermark = await readWatermark();
    if (watermark) {
      const elapsed = (options.now?.getTime() ?? Date.now()) - Date.parse(watermark.last_checked_at);
      if (Number.isFinite(elapsed) && elapsed < COOLDOWN_MS) {
        return [{ collection: 'all', outcome: 'cooldown' }];
      }
    }
  }

  const reports: QdrantHealReport[] = [];

  for (const collection of QDRANT_COLLECTIONS) {
    let info: CollectionInfo | null;
    try {
      info = await fetchCollectionInfo(url, apiKey, collection);
    } catch (err) {
      reports.push({
        collection,
        outcome: 'unreachable',
        notes: (err as Error).message,
      });
      continue;
    }
    if (info === null) {
      reports.push({ collection, outcome: 'collection_absent' });
      continue;
    }

    const present = new Set(Object.keys(info.result?.payload_schema ?? {}));
    const missing = QDRANT_INDEXES.filter((idx) => !present.has(idx.field_name));

    if (missing.length === 0) {
      reports.push({ collection, outcome: 'fresh' });
      continue;
    }

    const repaired: string[] = [];
    for (const field of missing) {
      const ok = await putIndex(url, apiKey, collection, field);
      if (ok) repaired.push(field.field_name);
    }
    reports.push({
      collection,
      outcome: repaired.length > 0 ? 'repaired' : 'unreachable',
      repaired_fields: repaired.length > 0 ? repaired : undefined,
    });

    if (repaired.length > 0) {
      void recordTelemetry('qdrant_index_repaired', {
        metadata: { collection, fields: repaired.join(',') },
      });
    }
  }

  await writeWatermark(options.now);
  return reports;
}
