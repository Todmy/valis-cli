export {
  jaccard,
  clusterByJaccard,
  averagePairwiseJaccard,
  deduplicatePatterns,
  detectPatterns,
  patternSummary,
} from './patterns.js';

export { runSynthesis } from './runner.js';
export type { SynthesisReport, SynthesisOptions } from './runner.js';

export {
  cosineSimilarity,
  clusterPoints,
  clusterDecisions,
} from './clustering.js';
export type { Cluster, VectorPoint, ClusterOptions } from './clustering.js';

export { buildClusterSummary, compressCluster, compressClusters } from './compress.js';
export type { CompressionReport } from './compress.js';

export { ClusterRegistry, CLUSTER_SIMILARITY_THRESHOLD, MIN_SINGLETONS_FOR_CLUSTER } from './cluster-registry.js';
export type { ClusterInfo } from './cluster-registry.js';

export { generateGroupSummary } from './summarize.js';
