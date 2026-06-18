-- 027: Drop the decision_proposals table and its descendants.
--
-- Rationale: decision_proposals was a parallel surface for engine-spotted
-- patterns, kept separate from `decisions` (status='proposed') with its own
-- lifecycle, dedup machinery, and triage flow. In practice it surfaced as a
-- second "things to review" inbox that none of the real users could
-- distinguish from drafts — and engine writes (the only writer) never
-- landed in any production deployment (zero rows across all projects at
-- the time of this drop).
--
-- Unification model going forward:
--   - One sentence of truth: `decisions` with `status` lifecycle.
--   - Drafts (status='proposed') are the universal review queue.
--   - Engine, when it ships, will INSERT INTO decisions with status='proposed'
--     and a sentinel created_by — same review surface, attribution by author.
--
-- CASCADE drops the related FKs that 016/018 added (predecessor_proposal_id
-- self-reference, captured_decision_id, source_audit_id, dismissed_by, etc).
-- Indexes on decision_proposals are dropped automatically with the table.

-- The only inbound FK to decision_proposals is its own self-reference
-- (predecessor_proposal_id, migration 018); CASCADE handles that. The
-- decision_proposals.captured_decision_id → decisions(id) edge points the
-- other way, so rows in `decisions` are untouched. The
-- decision_proposals.source_audit_id → audit_entries(id) edge is also
-- outbound — audit history survives. Nothing in `decisions` references
-- `decision_proposals`.
DROP TABLE IF EXISTS decision_proposals CASCADE;

COMMENT ON TABLE decisions IS
  'Unified team-knowledge table. status lifecycle: proposed → active → '
  'deprecated|superseded. Drafts (proposed) flow through the same triage '
  'queue regardless of author. Migration 027 retired decision_proposals.';
