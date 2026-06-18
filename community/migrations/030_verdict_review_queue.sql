-- 042-contradiction-resolution: shared Stage-A verdict-review queue.
--
-- Background
--   Today contradictions are DETECTED and DISPLAYED but only resolved
--   incidentally (when a decision is independently deprecated/superseded).
--   Feature 042 adds a shared human-review queue with two verdict types —
--   proposed-decision relevance ranking (US1) and contradiction resolution
--   (US2) — under escalate-first (no machine verdict changes state without an
--   explicit human confirm). See specs/042-contradiction-resolution/.
--
-- Schema changes (ADDITIVE only — Constitution: backward-compatible migrations)
--   A. contradictions: cache the LLM verdict + record the resolution outcome.
--      + verdict_classification / verdict_confidence / verdict_assessed_at
--      + recommended_action
--      + resolution_type / resolution_reason
--      + suppressed (dismissed-compatible pairs must not re-nag)
--      + widen status CHECK: 'open' | 'resolved' | 'acknowledged_conflict'
--   B. decisions: cache the ranker's keep/dismiss recommendation for ordering.
--      + triage_disposition / triage_confidence / triage_assessed_at
--   C. partial indexes backing the two queue reads.
--
-- Recommendations are advisory caches only — every state change still flows
-- through /api/change-status with an explicit human confirm (FR-007).
--
-- Reversibility
--   Drop the added columns + indexes and restore the original
--   contradictions_status_check (status IN ('open','resolved')).
--
-- See specs/042-contradiction-resolution/{spec.md, data-model.md}.

-- ============================================================
-- A. contradictions — verdict cache + resolution outcome
-- ============================================================

ALTER TABLE contradictions
  ADD COLUMN IF NOT EXISTS verdict_classification TEXT
    CHECK (verdict_classification IS NULL
           OR verdict_classification IN ('replacement', 'genuine_conflict', 'compatible')),
  ADD COLUMN IF NOT EXISTS verdict_confidence REAL
    CHECK (verdict_confidence IS NULL OR (verdict_confidence BETWEEN 0.0 AND 1.0)),
  ADD COLUMN IF NOT EXISTS verdict_assessed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS recommended_action TEXT,
  ADD COLUMN IF NOT EXISTS resolution_type TEXT
    CHECK (resolution_type IS NULL
           OR resolution_type IN ('superseded', 'dismissed_compatible', 'flagged_conflict')),
  ADD COLUMN IF NOT EXISTS resolution_reason TEXT,
  ADD COLUMN IF NOT EXISTS suppressed BOOLEAN NOT NULL DEFAULT FALSE;

-- Widen the status CHECK to admit the 'acknowledged_conflict' terminal-ish
-- state produced by a flag-conflict resolution (FR-002a).
ALTER TABLE contradictions
  DROP CONSTRAINT IF EXISTS contradictions_status_check;
ALTER TABLE contradictions
  ADD CONSTRAINT contradictions_status_check
  CHECK (status IN ('open', 'resolved', 'acknowledged_conflict'));

-- The queue reads open + acknowledged pairs (not resolved).
CREATE INDEX IF NOT EXISTS idx_contradictions_project_state
  ON contradictions (project_id, status)
  WHERE status <> 'resolved';

-- ============================================================
-- B. decisions — ranker recommendation cache (advisory)
-- ============================================================

ALTER TABLE decisions
  ADD COLUMN IF NOT EXISTS triage_disposition TEXT
    CHECK (triage_disposition IS NULL OR triage_disposition IN ('keep', 'dismiss')),
  ADD COLUMN IF NOT EXISTS triage_confidence REAL
    CHECK (triage_confidence IS NULL OR (triage_confidence BETWEEN 0.0 AND 1.0)),
  ADD COLUMN IF NOT EXISTS triage_assessed_at TIMESTAMPTZ;

-- Order the ranker queue: clearest dismissals first, project-scoped.
CREATE INDEX IF NOT EXISTS idx_decisions_proposed_triage
  ON decisions (project_id, triage_disposition, triage_confidence)
  WHERE status = 'proposed';

-- ============================================================
-- Column comments (traceability)
-- ============================================================

COMMENT ON COLUMN contradictions.verdict_classification IS
  '042: cached Haiku verdict — replacement|genuine_conflict|compatible. Advisory; never auto-applies.';
COMMENT ON COLUMN contradictions.resolution_type IS
  '042: how the pair was resolved — superseded|dismissed_compatible|flagged_conflict.';
COMMENT ON COLUMN contradictions.suppressed IS
  '042: dismissed-compatible pairs are suppressed from re-flagging until a material change.';
COMMENT ON COLUMN decisions.triage_disposition IS
  '042: cached ranker recommendation (keep|dismiss) for the proposed-review queue. Advisory; dismiss still needs an explicit human confirm.';
