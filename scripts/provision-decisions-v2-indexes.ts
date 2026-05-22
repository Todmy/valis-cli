#!/usr/bin/env tsx
/**
 * One-shot fix-up: provision payload indexes on `decisions_v2` collection
 * that was created without them by the direct-reindex path.
 *
 * Without these indexes, Qdrant's strict_mode rejects every filtered query
 * → prod search returns offline.
 *
 * Idempotent — Qdrant silently ignores duplicate createPayloadIndex calls.
 *
 * Combines the 3 base indexes from ensureCollection (org_id, type, project_id)
 * with the 9 structured-filter indexes from ensureStructuredFilterIndexes
 * (status, author, source, confidence, created_at, pinned, affects,
 * enriched_by, outcome).
 */

import { QdrantClient } from '@qdrant/js-client-rest';
import { ensureStructuredFilterIndexes } from '../src/cloud/qdrant/payload-indexes.js';

const COLLECTION = 'decisions_v2';

interface IndexSpec {
  field_name: string;
  field_schema: 'keyword' | 'float' | 'datetime' | 'bool';
}

const BASE_INDEXES: IndexSpec[] = [
  { field_name: 'org_id', field_schema: 'keyword' },
  { field_name: 'type', field_schema: 'keyword' },
  { field_name: 'project_id', field_schema: 'keyword' },
];

async function main() {
  const url = process.env.QDRANT_URL;
  const apiKey = process.env.QDRANT_API_KEY;
  if (!url || !apiKey) { console.error('Missing QDRANT_URL/QDRANT_API_KEY'); process.exit(2); }

  const qdrant = new QdrantClient({ url, apiKey });

  // 1. Base indexes (mirror what ensureCollection would do for a fresh collection)
  console.log(`Provisioning base indexes on ${COLLECTION}:`);
  for (const spec of BASE_INDEXES) {
    try {
      await qdrant.createPayloadIndex(COLLECTION, spec);
      console.log(`  [ok] ${spec.field_name}`);
    } catch (e) {
      console.log(`  [fail] ${spec.field_name}: ${(e as Error).message.slice(0, 200)}`);
    }
  }

  // 2. Structured-filter indexes (mirror ensureStructuredFilterIndexes but
  //    against decisions_v2 — the existing helper hardcodes to COLLECTION_NAME
  //    constant which resolves via env; that should be `decisions_v2` here)
  console.log(`\nProvisioning structured-filter indexes:`);
  const results = await ensureStructuredFilterIndexes(qdrant);
  for (const r of results) {
    const tag = r.status === 'created' ? 'ok'
      : r.status === 'already_exists' ? 'exists' : 'fail';
    console.log(`  [${tag}] ${r.field_name}${r.error ? `: ${r.error}` : ''}`);
  }

  // 3. Verify
  const info = await qdrant.getCollection(COLLECTION);
  const schema = (info as unknown as { payload_schema?: Record<string, unknown> }).payload_schema ?? {};
  console.log(`\n${COLLECTION} now has ${Object.keys(schema).length} indexed fields:`);
  for (const field of Object.keys(schema).sort()) {
    console.log(`  ${field}`);
  }
}

main().catch((e) => { console.error(e); process.exit(2); });
