// Synthesis module — pattern detection, Jaccard similarity, runner
// Phase 3: Search Intelligence, Data Quality & Growth
export {
  jaccard,
  clusterByJaccard,
  averagePairwiseJaccard,
  deduplicatePatterns,
  detectPatterns,
  type DetectPatternsOptions,
} from './patterns.js';

export { runSynthesis, type SynthesisOptions, type SynthesisReport } from './runner.js';
