/**
 * Two-stage multi-signal search reranker.
 *
 * Merges approaches from Q4-A, Q4-B, and Q4-C:
 *
 * **Stage 1 (recall):** 5-signal linear combination with content-aware
 * recency decay (Q4-A) and area co-occurrence in graph connectivity (Q4-C).
 *
 * **Stage 2 (precision):** Fine-grained reranking with 3 additional signals
 * from Q4-B:
 *   - Token overlap (exact term matching)
 *   - Negation awareness (query-document negation alignment)
 *   - Freshness boost (recency among area peers)
 *
 * Stage 2 produces the final top-N with `matchReason` explanations.
 *
 * ```
 * stage1_score = w.semantic   * semantic_score
 *              + w.bm25       * bm25_score
 *              + w.recency    * content_aware_recency_decay
 *              + w.importance * importance
 *              + w.graph      * graph_connectivity (with area co-occurrence)
 *
 * stage2_score = 0.70 * stage1_score (normalized)
 *              + 0.15 * token_overlap
 *              + 0.05 * negation_awareness
 *              + 0.10 * freshness_boost
 * ```
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
import {
  contentAwareRecencyDecay,
  importanceScore,
  graphConnectivity,
  normalizeBm25,
  tokenOverlapScore,
  negationAwarenessScore,
  freshnessBoost,
  clusterBoost,
} from './signals.js';
import { analyzeQuery } from './query-analyzer.js';
import type { QueryAnalysis } from './query-analyzer.js';

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/** Default signal weights per research.md. Sum = 1.0. */
export const DEFAULT_WEIGHTS: SignalWeights = {
  semantic: 0.30,
  bm25: 0.20,
  recency: 0.20,
  importance: 0.15,
  graph: 0.10,
  cluster: 0.05,
};

/** Stage 2 blending weights. Sum = 1.0. */
export const STAGE2_WEIGHTS = {
  stage1: 0.70,
  tokenOverlap: 0.15,
  negation: 0.05,
  freshness: 0.10,
} as const;

const DEFAULT_HALF_LIFE_DAYS = 90;

/** Default number of candidates to take from stage 1 for stage 2. */
const STAGE2_CANDIDATE_LIMIT = 50;

// ---------------------------------------------------------------------------
// Weight normalization
// ---------------------------------------------------------------------------

/**
 * Ensure weights sum to exactly 1.0.  If they do not, normalize
 * proportionally.  If all weights are zero, fall back to equal weights.
 */
export function normalizeWeights(raw: SignalWeights): SignalWeights {
  const sum = raw.semantic + raw.bm25 + raw.recency + raw.importance + raw.graph + raw.cluster;

  if (sum === 0) {
    return { semantic: 0.2, bm25: 0.2, recency: 0.2, importance: 0.2, graph: 0.1, cluster: 0.1 };
  }

  if (Math.abs(sum - 1.0) < 1e-9) return raw;

  return {
    semantic: raw.semantic / sum,
    bm25: raw.bm25 / sum,
    recency: raw.recency / sum,
    importance: raw.importance / sum,
    graph: raw.graph / sum,
    cluster: raw.cluster / sum,
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
  /** Number of decisions in this result's cluster (Q5). 0 = no cluster. */
  cluster_member_count?: number;
}

// ---------------------------------------------------------------------------
// Match reason generation (from Q4-B)
// ---------------------------------------------------------------------------

/**
 * Generate a human-readable explanation of why a result matched.
 */
function buildMatchReason(
  signals: SignalValues,
  stage2Signals: Stage2Signals,
  result: RerankableResult,
  analysis: QueryAnalysis | null,
): string {
  const parts: string[] = [];

  // Semantic similarity — always the primary signal
  if (signals.semantic_score >= 0.8) {
    parts.push(`High semantic similarity (${signals.semantic_score.toFixed(2)})`);
  } else if (signals.semantic_score >= 0.5) {
    parts.push(`Semantic match (${signals.semantic_score.toFixed(2)})`);
  }

  // Token overlap — exact term matches
  if (stage2Signals.tokenOverlap > 0 && analysis) {
    const matchedTerms = findMatchedTerms(analysis.entities, result);
    if (matchedTerms.length > 0) {
      parts.push(`exact term match '${matchedTerms.join("', '")}'`);
    }
  }

  // Negation awareness
  if (stage2Signals.negation > 0) {
    parts.push('negation-context match');
  }

  // Recency
  if (signals.recency_decay >= 0.9) {
    const ageDays = getAgeDays(result.created_at);
    if (ageDays <= 7) {
      parts.push(`recent (${ageDays} day${ageDays === 1 ? '' : 's'} ago)`);
    }
  }

  // Related area + freshness
  if (stage2Signals.freshness > 0.5 && result.affects.length > 0) {
    parts.push(`related area '${result.affects[0]}'`);
  }

  // Importance
  if (signals.importance >= 0.8) {
    if (result.pinned) {
      parts.push('pinned');
    } else {
      parts.push('high confidence');
    }
  }

  // Graph connectivity
  if (signals.graph_connectivity > 0) {
    parts.push('referenced by other decisions');
  }

  if (parts.length === 0) {
    parts.push(`relevance score ${signals.semantic_score.toFixed(2)}`);
  }

  // Capitalize first part, join with ' + '
  const joined = parts.join(' + ');
  return joined.charAt(0).toUpperCase() + joined.slice(1);
}

/**
 * Find which query entities appear in the result text.
 */
function findMatchedTerms(entities: string[], result: RerankableResult): string[] {
  const text = `${result.summary || ''} ${result.detail}`.toLowerCase();
  return entities.filter((e) => {
    const re = new RegExp(`\\b${e.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    return re.test(text);
  });
}

/**
 * Compute age in whole days from ISO-8601 timestamp.
 */
function getAgeDays(createdAt: string, now?: number): number {
  const MS_PER_DAY = 86_400_000;
  const currentTime = now ?? Date.now();
  return Math.max(0, Math.floor((currentTime - new Date(createdAt).getTime()) / MS_PER_DAY));
}

// ---------------------------------------------------------------------------
// Stage 2 signal container
// ---------------------------------------------------------------------------

interface Stage2Signals {
  tokenOverlap: number;
  negation: number;
  freshness: number;
}

// ---------------------------------------------------------------------------
// Core reranking — Stage 1 (backward compatible)
// ---------------------------------------------------------------------------

/**
 * Stage 1: Rerank using the original 5-signal composite formula.
 *
 * This function is the backward-compatible entry point. When called
 * without a query, it performs stage-1 only (same behavior as before).
 * When called with a query string, it performs both stages.
 *
 * @param results  Raw search results from Qdrant (up to 50).
 * @param config   Org-level reranking configuration (optional overrides).
 * @param now      Current time in ms (injectable for deterministic tests).
 * @param query    Search query for stage-2 reranking (optional).
 * @returns Results sorted by composite_score descending, each augmented
 *          with `composite_score`, `signals` breakdown, and `matchReason`.
 */
export function rerank<T extends RerankableResult>(
  results: T[],
  config?: RerankConfig,
  now?: number,
  query?: string,
): RerankedResult[] {
  if (results.length === 0) return [];

  // --- Stage 1: 5-signal linear combination --------------------------------
  const stage1Results = stage1Rerank(results, config, now);

  // If no query provided, return stage-1 results (backward compat)
  if (!query) return stage1Results;

  // --- Stage 2: Fine-grained reranking with query analysis -----------------
  return stage2Rerank(stage1Results, query, now);
}

/**
 * Stage 1: 5-signal reranking with content-aware decay (Q4-A) and
 * area co-occurrence in graph connectivity (Q4-C).
 *
 * Exported for direct use and testing.
 */
export function stage1Rerank<T extends RerankableResult>(
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
    let clusterVal: number;

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
      // Use content-aware decay (Q4-A): type-specific half-life curves modify
      // the base recency signal (architectural decisions decay slowly,
      // lessons decay fast). The base halfLife acts as a scaling factor.
      recencyVal = contentAwareRecencyDecay(r.created_at, r.type, halfLife, r.pinned ?? false, currentTime);
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

    try {
      clusterVal = clusterBoost(r.cluster_member_count ?? 0);
    } catch {
      clusterVal = 0;
    }

    const signals: SignalValues = {
      semantic_score: semanticVal,
      bm25_score: bm25Val,
      recency_decay: recencyVal,
      importance: importanceVal,
      graph_connectivity: graphVal,
      cluster_boost: clusterVal,
    };

    // Check if all signals failed (all zero)
    const allZero =
      signals.semantic_score === 0 &&
      signals.bm25_score === 0 &&
      signals.recency_decay === 0 &&
      signals.importance === 0 &&
      signals.graph_connectivity === 0 &&
      signals.cluster_boost === 0;

    const composite = allZero
      ? r.score ?? 0 // fallback to raw Qdrant score
      : weights.semantic * signals.semantic_score +
        weights.bm25 * signals.bm25_score +
        weights.recency * signals.recency_decay +
        weights.importance * signals.importance +
        weights.graph * signals.graph_connectivity +
        weights.cluster * signals.cluster_boost;

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

// ---------------------------------------------------------------------------
// Stage 2: Fine-grained precision reranking (from Q4-B)
// ---------------------------------------------------------------------------

/**
 * Stage 2: Apply fine-grained reranking with query-aware signals.
 *
 * Takes stage-1 results (up to STAGE2_CANDIDATE_LIMIT), computes
 * token overlap, negation awareness, and freshness boost, then
 * blends with the stage-1 score.
 *
 * @param stage1Results  Stage-1 reranked results (sorted by composite_score).
 * @param query          Raw search query string.
 * @param now            Current time in ms (injectable for testing).
 * @returns Re-sorted results with updated composite_score and matchReason.
 */
export function stage2Rerank(
  stage1Results: RerankedResult[],
  query: string,
  now?: number,
): RerankedResult[] {
  if (stage1Results.length === 0) return [];

  // Take top candidates for stage 2
  const candidates = stage1Results.slice(0, STAGE2_CANDIDATE_LIMIT);

  // Analyze the query
  const analysis = analyzeQuery(query);

  // Normalize stage-1 composite scores to [0, 1] for blending
  const s1Scores = candidates.map((r) => r.composite_score);
  const s1Min = Math.min(...s1Scores);
  const s1Max = Math.max(...s1Scores);
  const s1Range = s1Max - s1Min;

  // Compute stage-2 signals and blend
  const reranked: RerankedResult[] = candidates.map((r) => {
    const docText = `${r.summary || ''} ${r.detail}`;

    // Stage 2 signals
    const tokenOvlp = tokenOverlapScore(query, docText);
    const negation = negationAwarenessScore(analysis.hasNegation, analysis.entities, docText);
    const freshness = freshnessBoost(r.id, r.created_at, r.affects, candidates);

    const stage2Sigs: Stage2Signals = {
      tokenOverlap: tokenOvlp,
      negation,
      freshness,
    };

    // Normalize stage-1 score
    const normalizedS1 = s1Range > 0
      ? (r.composite_score - s1Min) / s1Range
      : 0.5;

    // Adjust stage-2 weights based on query type
    const s2w: Record<string, number> = { ...STAGE2_WEIGHTS };
    if (analysis.type === 'negation') {
      // Boost negation weight, reduce stage1 slightly
      s2w.negation = 0.15;
      s2w.stage1 = 0.60;
    } else if (analysis.type === 'factual') {
      // Boost token overlap for factual queries (exact term matching matters more)
      s2w.tokenOverlap = 0.20;
      s2w.stage1 = 0.65;
    }

    // Blend stage-1 and stage-2 signals
    const blendedScore =
      s2w.stage1 * normalizedS1 +
      s2w.tokenOverlap * tokenOvlp +
      s2w.negation * negation +
      s2w.freshness * freshness;

    // Generate match reason
    const matchReason = buildMatchReason(r.signals, stage2Sigs, r, analysis);

    return {
      ...r,
      composite_score: blendedScore,
      matchReason,
    };
  });

  // Sort by blended score descending
  reranked.sort((a, b) => b.composite_score - a.composite_score);

  return reranked;
}
