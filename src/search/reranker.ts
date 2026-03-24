/**
 * Multi-signal search reranker.
 *
 * Combines 5 signals into a composite score for each search result:
 *
 * ```
 * composite = w.semantic   * semantic_score
 *           + w.bm25       * bm25_score
 *           + w.recency    * recency_decay
 *           + w.importance * importance
 *           + w.graph      * graph_connectivity
 * ```
 *
 * Default weights (from research.md):
 * | Signal    | Weight |
 * |-----------|--------|
 * | semantic  | 0.30   |
 * | bm25      | 0.20   |
 * | recency   | 0.20   |
 * | importance| 0.15   |
 * | graph     | 0.15   |
 *
 * Performance target: <10ms on 50 results (all in-memory, no I/O).
 *
 * @module search/reranker
 */

import type {
  SearchResult,
  SignalWeights,
  SignalValues,
  RerankedResult,
  RerankConfig,
} from '../types.js';
import { recencyDecay, importanceScore, graphConnectivity, normalizeBm25 } from './signals.js';

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/** Default signal weights per research.md. Sum = 1.0. */
export const DEFAULT_WEIGHTS: SignalWeights = {
  semantic: 0.30,
  bm25: 0.20,
  recency: 0.20,
  importance: 0.15,
  graph: 0.15,
};

const DEFAULT_HALF_LIFE_DAYS = 90;

// ---------------------------------------------------------------------------
// Weight normalization
// ---------------------------------------------------------------------------

/**
 * Ensure weights sum to exactly 1.0.  If they do not, normalize
 * proportionally.  If all weights are zero, fall back to equal weights.
 */
export function normalizeWeights(raw: SignalWeights): SignalWeights {
  const sum = raw.semantic + raw.bm25 + raw.recency + raw.importance + raw.graph;

  if (sum === 0) {
    return { semantic: 0.2, bm25: 0.2, recency: 0.2, importance: 0.2, graph: 0.2 };
  }

  if (Math.abs(sum - 1.0) < 1e-9) return raw;

  return {
    semantic: raw.semantic / sum,
    bm25: raw.bm25 / sum,
    recency: raw.recency / sum,
    importance: raw.importance / sum,
    graph: raw.graph / sum,
  };
}

// ---------------------------------------------------------------------------
// Input type — extends SearchResult with the extra payload fields the
// reranker needs.  Callers map Qdrant results into this shape.
// ---------------------------------------------------------------------------

/** Search result with optional payload fields needed by the reranker. */
export interface RerankableResult extends SearchResult {
  /** Qdrant BM25 sparse vector score (raw, unbounded). */
  bm25_score?: number;
  /** Decision confidence (0-1). */
  confidence?: number | null;
  /** Whether the decision is pinned. */
  pinned?: boolean;
  /** UUIDs of decisions this one depends on. */
  depends_on?: string[];
}

// ---------------------------------------------------------------------------
// Core reranking
// ---------------------------------------------------------------------------

/**
 * Rerank a set of search results using the 5-signal composite formula.
 *
 * @param results  Raw search results from Qdrant (up to 50).
 * @param config   Org-level reranking configuration (optional overrides).
 * @param now      Current time in ms (injectable for deterministic tests).
 * @returns Results sorted by composite_score descending, each augmented
 *          with `composite_score` and `signals` breakdown.
 */
export function rerank<T extends RerankableResult>(
  results: T[],
  config?: RerankConfig,
  now?: number,
): RerankedResult[] {
  if (results.length === 0) return [];

  const halfLife = config?.halfLifeDays ?? DEFAULT_HALF_LIFE_DAYS;
  const weights = normalizeWeights({
    ...DEFAULT_WEIGHTS,
    ...config?.weights,
  });
  const currentTime = now ?? Date.now();

  // --- Pre-compute BM25 normalization across the full result set -----------
  const rawBm25 = results.map((r) => r.bm25_score ?? 0);
  const normalizedBm25 = normalizeBm25(rawBm25);

  // --- Pre-compute graph connectivity for every result --------------------
  // (needs the full result set to count inbound refs)
  const graphScores = new Map<string, number>();
  for (const r of results) {
    graphScores.set(r.id, graphConnectivity(r.id, results));
  }

  // --- Compute signals & composite for each result ------------------------
  const reranked: RerankedResult[] = results.map((r, idx) => {
    let semanticVal: number;
    let bm25Val: number;
    let recencyVal: number;
    let importanceVal: number;
    let graphVal: number;

    try {
      semanticVal = r.score ?? 0;
    } catch {
      semanticVal = 0;
    }

    try {
      bm25Val = normalizedBm25[idx] ?? 0;
    } catch {
      bm25Val = 0;
    }

    try {
      recencyVal = recencyDecay(r.created_at, halfLife, r.pinned ?? false, currentTime);
    } catch {
      recencyVal = 0;
    }

    try {
      importanceVal = importanceScore(r.confidence, r.pinned ?? false);
    } catch {
      importanceVal = 0;
    }

    try {
      graphVal = graphScores.get(r.id) ?? 0;
    } catch {
      graphVal = 0;
    }

    const signals: SignalValues = {
      semantic_score: semanticVal,
      bm25_score: bm25Val,
      recency_decay: recencyVal,
      importance: importanceVal,
      graph_connectivity: graphVal,
    };

    // Check if all signals failed (all zero)
    const allZero =
      signals.semantic_score === 0 &&
      signals.bm25_score === 0 &&
      signals.recency_decay === 0 &&
      signals.importance === 0 &&
      signals.graph_connectivity === 0;

    const composite = allZero
      ? r.score ?? 0 // fallback to raw Qdrant score
      : weights.semantic * signals.semantic_score +
        weights.bm25 * signals.bm25_score +
        weights.recency * signals.recency_decay +
        weights.importance * signals.importance +
        weights.graph * signals.graph_connectivity;

    return {
      ...r,
      composite_score: composite,
      signals,
      confidence: r.confidence,
      pinned: r.pinned,
      depends_on: r.depends_on,
    };
  });

  // --- Sort by composite_score descending ---------------------------------
  reranked.sort((a, b) => b.composite_score - a.composite_score);

  return reranked;
}
