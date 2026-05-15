#!/usr/bin/env tsx
/**
 * 032/Track 6 — one-shot script to provision Qdrant payload indexes for the
 * structured `valis_search` filter dimensions (status, author, source,
 * confidence, created_at, pinned, affects, enriched_by, outcome).
 *
 * Idempotent — re-running against a collection that already has the indexes
 * is a no-op. Safe to wire into CI/CD as part of the deploy pipeline.
 *
 * Usage:
 *   QDRANT_URL=... QDRANT_API_KEY=... pnpm tsx packages/cli/scripts/ensure-payload-indexes.ts
 *
 * Exits 0 even when some indexes failed to create — Qdrant continues to
 * evaluate filters without an index (slower), so a partial failure is not
 * a deployment blocker. The script prints a status table for each field
 * so the operator can decide whether to investigate.
 */

import { QdrantClient } from '@qdrant/js-client-rest';
import { ensureStructuredFilterIndexes } from '../src/cloud/qdrant/payload-indexes.js';

async function main(): Promise<void> {
  const url = process.env.QDRANT_URL;
  const apiKey = process.env.QDRANT_API_KEY;
  if (!url || !apiKey) {
    console.error('QDRANT_URL and QDRANT_API_KEY must be set');
    process.exit(2);
  }

  const qdrant = new QdrantClient({ url, apiKey });

  console.log('Ensuring structured-filter payload indexes…\n');
  const results = await ensureStructuredFilterIndexes(qdrant);

  for (const r of results) {
    const tag =
      r.status === 'created'
        ? 'created'
        : r.status === 'already_exists'
          ? 'exists'
          : 'failed';
    console.log(`  ${tag.padEnd(8)} ${r.field_name}${r.error ? `  — ${r.error}` : ''}`);
  }

  const failed = results.filter((r) => r.status === 'failed');
  if (failed.length > 0) {
    console.warn(`\n${failed.length} index(es) failed — filters will fall back to non-indexed evaluation.`);
  } else {
    console.log(`\nAll ${results.length} indexes provisioned.`);
  }
}

main().catch((err) => {
  console.error('ensure-payload-indexes: fatal error', err);
  process.exit(1);
});
