/**
 * 021/T012: search-fn adapters — `hybrid`, `dense_only`, `bm25_only`.
 *
 * Each adapter mirrors the production retrieval pipeline (hybrid prefetch
 * + RRF fusion + ×4 over-fetch + max-score-per-`doc_id` dedup), but
 * parameterised by an ephemeral collection name and bound to the
 * `BENCHMARK_QDRANT_*` credentials (NEVER prod).
 *
 * Contract (`specs/021-public-benchmarks/contracts/search-fn.contract.md`):
 *   - `result.length <= k`
 *   - 1-based contiguous ranks: `result[i].rank === i + 1`
 *   - No duplicate `doc_id`s
 *   - Determinism (same `(query, k)` → same hits, same order)
 *   - Throws on Qdrant errors (no retry)
 */

import { QdrantClient } from '@qdrant/js-client-rest';
import {
  DENSE_MODEL,
  BM25_MODEL,
  DENSE_VECTOR_NAME,
  BM25_VECTOR_NAME,
} from '../cloud/embedding.js';
import type { SearchFn, SearchHit } from './types.js';

interface QdrantPoint {
  id: string | number;
  score?: number;
  payload?: Record<string, unknown> | null | undefined;
}

interface BenchmarkQdrantEnv {
  url: string;
  apiKey: string;
}

function readBenchmarkEnv(): BenchmarkQdrantEnv {
  const url = process.env.BENCHMARK_QDRANT_URL;
  const apiKey = process.env.BENCHMARK_QDRANT_API_KEY;
  if (!url || !apiKey) {
    throw new Error(
      'BENCHMARK_QDRANT_URL and BENCHMARK_QDRANT_API_KEY must both be set.',
    );
  }
  return { url, apiKey };
}

let _client: QdrantClient | null = null;
function getBenchmarkClient(): QdrantClient {
  if (_client) return _client;
  const { url, apiKey } = readBenchmarkEnv();
  _client = new QdrantClient({ url, apiKey });
  return _client;
}

/**
 * Reduce a raw Qdrant point list to `SearchHit[]` with 1-based ranks and
 * one entry per `doc_id` (max score wins). Truncates to `k`.
 */
function dedupAndRank(points: QdrantPoint[], k: number): SearchHit[] {
  const best = new Map<string, { score: number }>();
  for (const p of points) {
    const docId = (p.payload?.doc_id as string | undefined) ?? String(p.id);
    const score = p.score ?? 0;
    const existing = best.get(docId);
    if (!existing || score > existing.score) {
      best.set(docId, { score });
    }
  }
  const ranked = Array.from(best.entries())
    .map(([doc_id, { score }]) => ({ doc_id, score }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .map((entry, i): SearchHit => ({
      doc_id: entry.doc_id,
      score: entry.score,
      rank: i + 1,
    }));
  return ranked;
}

/**
 * Production-stack hybrid retrieval: dense + BM25 prefetch with RRF fusion.
 * Mirrors `packages/cli/src/cloud/qdrant/search.ts#hybridSearch` minus the
 * project-scoping / filter / siblings-enrichment / scroll-fallback layers
 * — none of which affect retrieval *quality* on a single-tenant benchmark
 * collection.
 */
export function hybridSearchFn(collectionName: string): SearchFn {
  const denseModel = DENSE_MODEL;
  return async (query: string, k: number): Promise<SearchHit[]> => {
    const trimmed = query.trim();
    if (trimmed.length === 0) return [];

    const qdrant = getBenchmarkClient();
    const fetchLimit = k * 4;
    const results = await qdrant.query(collectionName, {
      prefetch: [
        {
          query: { text: trimmed, model: denseModel } as never,
          using: DENSE_VECTOR_NAME,
          limit: fetchLimit * 2,
        },
        {
          query: { text: trimmed, model: BM25_MODEL } as never,
          using: BM25_VECTOR_NAME,
          limit: fetchLimit * 2,
        },
      ],
      query: { fusion: 'rrf' } as never,
      limit: fetchLimit,
      with_payload: true,
    });
    return dedupAndRank(results.points as QdrantPoint[], k);
  };
}

/**
 * Dense-only baseline: same e5-small model, no BM25 fusion. Used to
 * attribute hybrid's gain to the lexical signal.
 */
export function denseOnlySearchFn(collectionName: string): SearchFn {
  const denseModel = DENSE_MODEL;
  return async (query: string, k: number): Promise<SearchHit[]> => {
    const trimmed = query.trim();
    if (trimmed.length === 0) return [];

    const qdrant = getBenchmarkClient();
    const fetchLimit = k * 4;
    const results = await qdrant.query(collectionName, {
      query: { text: trimmed, model: denseModel } as never,
      using: DENSE_VECTOR_NAME,
      limit: fetchLimit,
      with_payload: true,
    });
    return dedupAndRank(results.points as QdrantPoint[], k);
  };
}

/**
 * BM25-only baseline: same chunking, no dense vectors. Lower bound when the
 * corpus is heavily paraphrase-based (LongMemEval is) — the gap to hybrid
 * surfaces the semantic-signal contribution.
 */
export function bm25OnlySearchFn(collectionName: string): SearchFn {
  return async (query: string, k: number): Promise<SearchHit[]> => {
    const trimmed = query.trim();
    if (trimmed.length === 0) return [];

    const qdrant = getBenchmarkClient();
    const fetchLimit = k * 4;
    const results = await qdrant.query(collectionName, {
      query: { text: trimmed, model: BM25_MODEL } as never,
      using: BM25_VECTOR_NAME,
      limit: fetchLimit,
      with_payload: true,
    });
    return dedupAndRank(results.points as QdrantPoint[], k);
  };
}
