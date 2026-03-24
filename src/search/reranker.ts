/**
 * Multi-signal reranker for search results.
 *
 * Computes a composite score from 5 weighted signals and sorts results
 * by that score. All operations are in-memory on an already-fetched
 * result set — no additional DB or Qdrant calls.
 *
 * Performance budget: <10ms on 50 results.
 *
 * @module search/reranker
 * @phase 003-search-growth (T006)
 */

import type {
  SearchResult,
  SignalWeights,
  SignalValues,
  RerankedResult,
} from '../types.js';
import {
  recencyDecay,
  importanceScore,
  graphConnectivity,
  normalizeBm25,
  computeInboundCounts,
} from './signals.js';

// ---------------------------------------------------------------------------
// Default weights (sum = 1.0)
// ---------------------------------------------------------------------------

export const DEFAULT_WEIGHTS: SignalWeights = {
  semantic: 0.30,
  bm25: 0.20,
  recency: 0.20,
  importance: 0.15,
  graph: 0.15,
};

// ---------------------------------------------------------------------------
// Org config shape for reranker
// ---------------------------------------------------------------------------

export interface RerankConfig {
  halfLifeDays?: number;
  weights?: Partial<SignalWeights>;
}

// ---------------------------------------------------------------------------
// Weight normalization
// ---------------------------------------------------------------------------

/**
 * Normalize weights so they sum to exactly 1.0.
 * Merges partial overrides with defaults, then scales.
 */
export function normalizeWeights(
  partial?: Partial<SignalWeights>,
): SignalWeights {
  const w: SignalWeights = { ...DEFAULT_WEIGHTS, ...partial };

  const sum = w.semantic + w.bm25 + w.recency + w.importance + w.graph;
  if (sum === 0) return { ...DEFAULT_WEIGHTS };
  if (Math.abs(sum - 1.0) < 1e-9) return w;

  return {
    semantic: w.semantic / sum,
    bm25: w.bm25 / sum,
    recency: w.recency / sum,
    importance: w.importance / sum,
    graph: w.graph / sum,
  };
}

// ---------------------------------------------------------------------------
// Composite score
// ---------------------------------------------------------------------------

/**
 * Compute the weighted composite score from individual signal values.
 */
export function compositeScore(
  signals: SignalValues,
  weights: SignalWeights,
): number {
  return (
    weights.semantic * signals.semantic_score +
    weights.bm25 * signals.bm25_score +
    weights.recency * signals.recency_decay +
    weights.importance * signals.importance +
    weights.graph * signals.graph_connectivity
  );
}

// ---------------------------------------------------------------------------
// Rerank
// ---------------------------------------------------------------------------

/**
 * Rerank search results using 5 weighted signals.
 *
 * 1. Normalize BM25 scores across the result set.
 * 2. Precompute inbound dependency counts for graph connectivity.
 * 3. For each result, compute all 5 signals.
 * 4. Compute composite score.
 * 5. Sort descending by composite score.
 *
 * On total signal failure, falls back to raw Qdrant score ordering.
 *
 * @param results  Raw search results from Qdrant (up to 50).
 * @param config  Optional org-level configuration overrides.
 * @param now  Optional current timestamp for testing.
 * @returns Reranked results with composite scores and signal breakdown.
 */
export function rerank(
  results: SearchResult[],
  config?: RerankConfig,
  now?: number,
): RerankedResult[] {
  if (results.length === 0) return [];

  const halfLife = config?.halfLifeDays ?? 90;
  const weights = normalizeWeights(config?.weights);
  const currentTime = now ?? Date.now();

  try {
    // Step 1: Normalize BM25 scores
    const rawBm25 = results.map((r) => r.bm25_score ?? 0);
    const normalizedBm25 = normalizeBm25(rawBm25);

    // Step 2: Precompute inbound counts for graph signal
    const inboundCounts = computeInboundCounts(results);
    let maxLoggedInbound = 0;
    for (const count of inboundCounts.values()) {
      const l = Math.log1p(count);
      if (l > maxLoggedInbound) maxLoggedInbound = l;
    }

    // Step 3-4: Compute signals and composite for each result
    const reranked: RerankedResult[] = results.map((result, i) => {
      const signals: SignalValues = {
        semantic_score: Math.max(0, Math.min(1, result.score ?? 0)),
        bm25_score: normalizedBm25[i],
        recency_decay: recencyDecay(
          result.created_at,
          halfLife,
          result.pinned ?? false,
          currentTime,
        ),
        importance: importanceScore(
          result.confidence,
          result.pinned ?? false,
        ),
        graph_connectivity: maxLoggedInbound === 0
          ? 0
          : Math.log1p(inboundCounts.get(result.id) ?? 0) / maxLoggedInbound,
      };

      return {
        ...result,
        composite_score: compositeScore(signals, weights),
        signals,
      };
    });

    // Step 5: Sort by composite score descending
    reranked.sort((a, b) => b.composite_score - a.composite_score);

    return reranked;
  } catch {
    // Total signal failure — fall back to raw Qdrant score ordering
    return results
      .map((r) => ({
        ...r,
        composite_score: r.score ?? 0,
        signals: {
          semantic_score: r.score ?? 0,
          bm25_score: 0,
          recency_decay: 0,
          importance: 0,
          graph_connectivity: 0,
        },
      }))
      .sort((a, b) => b.composite_score - a.composite_score);
  }
}
