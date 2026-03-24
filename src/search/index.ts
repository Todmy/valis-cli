/**
 * Search intelligence modules — signals, reranker, and suppression.
 *
 * @module search
 * @phase 003-search-growth
 */

export {
  recencyDecay,
  importanceScore,
  graphConnectivity,
  computeInboundCounts,
  normalizeBm25,
} from './signals.js';

export {
  DEFAULT_WEIGHTS,
  normalizeWeights,
  compositeScore,
  rerank,
  type RerankConfig,
} from './reranker.js';

export {
  suppressResults,
  groupByAffectsArea,
  type SuppressionResult,
} from './suppression.js';
