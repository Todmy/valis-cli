-- 018: Phase 12 supplements to decision_proposals — FR-039..FR-040 + FR-043 + D1.
--
-- Per spec 019 supplements (added 2026-04-26 from /speckit.clarify session):
--   - FR-040 escape-hatch: predecessor_proposal_id (nullable FK to dismissed predecessor)
--   - FR-039/043: dismiss_reason (nullable text, ≤200 chars), canonical reasons include 'cap_pressure'
--   - D1 dedup-key contract: sha256 over canonical_summary + sorted file_paths,
--     reused by FR-031 (active dedup) and FR-040 (post-dismissal recurrence count).
--   - Indexes for cap-pressure queries (FR-039) and dedup lookups (FR-031, FR-040).
--
-- Filename intentionally jumps from 017 (T053) to 018 to keep Phase 12 schema
-- additions strictly above the Phase 8/9 baseline range.

ALTER TABLE decision_proposals
  ADD COLUMN predecessor_proposal_id uuid NULL REFERENCES decision_proposals(id) ON DELETE SET NULL,
  ADD COLUMN dismiss_reason text NULL CHECK (dismiss_reason IS NULL OR length(dismiss_reason) <= 200),
  ADD COLUMN dedup_key text NULL;

COMMENT ON COLUMN decision_proposals.predecessor_proposal_id IS
  '019/FR-040 — when a NEW proposal is created because the same pattern recurred N times after a previous proposal was dismissed, this column points to that dismissed predecessor for audit lineage.';
COMMENT ON COLUMN decision_proposals.dismiss_reason IS
  '019/FR-039 + FR-043 — canonical values include ''cap_pressure'' (auto-eviction under cap), plus admin-supplied free-text up to 200 chars.';
COMMENT ON COLUMN decision_proposals.dedup_key IS
  '019/D1 — sha256(canonical_summary || ''\n'' || sorted_file_paths.join('','')). NULL on rows inserted before this migration; new inserts MUST populate it. Reused by FR-031 active dedup and FR-040 post-dismissal recurrence counting.';

-- Partial index for cap-pressure eviction (FR-039: oldest active >30 days).
-- Already covered by idx_decision_proposals_project_created from migration 016
-- since its key is (project_id, created_at DESC) — no new index needed.

-- Index for dedup_key lookups (FR-031 active vs FR-040 post-dismissal counter).
-- Partial: only rows with non-NULL dedup_key participate; NULL on legacy rows
-- inserted before this migration is intentional (no dedup history retro-applied).
CREATE INDEX idx_decision_proposals_dedup_key
  ON decision_proposals(project_id, dedup_key)
  WHERE dedup_key IS NOT NULL;
