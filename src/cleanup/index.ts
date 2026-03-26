// Cleanup module — dedup, orphan detection, runner
// Phase 3: Search Intelligence, Data Quality & Growth (US3, T021-T028)

export {
  findExactDuplicates,
  findNearDuplicates,
  deduplicateCandidates,
  type DedupCandidate,
} from './dedup.js';

export {
  findStaleOrphans,
  type OrphanCandidate,
} from './orphans.js';

export {
  runCleanup,
  type CleanupOptions,
  AUDIT_ACTION_AUTO_DEDUPED,
  AUDIT_ACTION_ORPHAN_FLAGGED,
} from './runner.js';

export {
  findSemanticGroups,
  pickRepresentative,
  suggestAction,
  type SemanticGroup,
  type SemanticGroupOptions,
} from './semantic-groups.js';
