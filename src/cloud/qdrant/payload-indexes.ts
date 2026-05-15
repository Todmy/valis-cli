/**
 * 032/Track 6 — Qdrant payload index management for structured filters.
 *
 * `valis_search` exposes 11 structured filter dimensions on top of the
 * vector layer. Qdrant evaluates payload filters with or without an index,
 * but indexed scans are sub-linear and the cost of provisioning indexes is
 * one-shot. This module centralises the index spec for the 9 indexable
 * payload fields and exposes an idempotent helper.
 *
 * Idempotent — Qdrant treats duplicate `createPayloadIndex` calls on an
 * existing index as a no-op. Failures are logged + non-blocking (filters
 * still work, just slower).
 */

import type { QdrantClient } from '@qdrant/js-client-rest';
import { COLLECTION_NAME } from './client.js';

type FieldSchema =
  | 'keyword'
  | 'integer'
  | 'float'
  | 'datetime'
  | 'bool'
  | 'text';

interface PayloadIndexSpec {
  field_name: string;
  field_schema: FieldSchema;
}

/**
 * The structured-filter dimensions exposed by `SearchFilterBuilder`. Order
 * matches the spec FR-011 listing for review readability. `affects` is
 * `keyword` even though it stores arrays — Qdrant `match.any` indexes the
 * element values directly.
 */
const STRUCTURED_FILTER_INDEXES: PayloadIndexSpec[] = [
  { field_name: 'status', field_schema: 'keyword' },
  { field_name: 'author', field_schema: 'keyword' },
  { field_name: 'source', field_schema: 'keyword' },
  { field_name: 'confidence', field_schema: 'float' },
  { field_name: 'created_at', field_schema: 'datetime' },
  { field_name: 'pinned', field_schema: 'bool' },
  { field_name: 'affects', field_schema: 'keyword' },
  { field_name: 'enriched_by', field_schema: 'keyword' },
  { field_name: 'outcome', field_schema: 'keyword' },
];

export interface IndexResult {
  field_name: string;
  status: 'created' | 'already_exists' | 'failed';
  error?: string;
}

/**
 * Ensure every structured-filter payload index exists. Safe to call
 * repeatedly — Qdrant ignores duplicate creation requests. Returns
 * per-field status so the caller can surface progress (e.g. a one-shot
 * provisioning script).
 *
 * Never throws — index creation failures are logged and surfaced via the
 * result tuple so the caller can decide whether to abort or proceed.
 * Constitution III: filters fall back to non-indexed evaluation if an
 * index never gets created.
 */
export async function ensureStructuredFilterIndexes(
  qdrant: QdrantClient,
): Promise<IndexResult[]> {
  const results: IndexResult[] = [];
  for (const spec of STRUCTURED_FILTER_INDEXES) {
    try {
      await qdrant.createPayloadIndex(COLLECTION_NAME, {
        field_name: spec.field_name,
        field_schema: spec.field_schema,
      });
      results.push({ field_name: spec.field_name, status: 'created' });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Qdrant emits varying error shapes for "already exists" — match
      // loosely so we don't treat duplicate creation as a real failure.
      if (/already exists|duplicate/i.test(message)) {
        results.push({
          field_name: spec.field_name,
          status: 'already_exists',
        });
      } else {
        console.warn(
          `[payload-indexes] createPayloadIndex(${spec.field_name}) failed: ${message}`,
        );
        results.push({
          field_name: spec.field_name,
          status: 'failed',
          error: message,
        });
      }
    }
  }
  return results;
}

/**
 * The canonical list of indexed fields — exposed so docs/tests can assert
 * the set without importing the internal type.
 */
export const STRUCTURED_FILTER_INDEXED_FIELDS: readonly string[] =
  STRUCTURED_FILTER_INDEXES.map((s) => s.field_name);
