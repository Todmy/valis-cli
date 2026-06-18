-- 022_phase13_data_model.sql
-- Feature 028-phase13-data-model (Track 5a): MAMA-inspired data model bundle.
--
-- Two additive surfaces:
--   1. Five new columns on `decisions` capturing what was considered and what
--      actually happened: outcome (+ reason + timestamp) + alternatives_considered
--      + risks. All defaulted so existing rows keep working without backfill.
--   2. New empty `decision_edges` table with the columns and constraints Track
--      5b (issue #31) will populate via the future `valis_evolve` MCP tool.
--      Track 5a writes nothing here — schema readiness only.
--
-- Per spec §FR-001/FR-002/FR-003: forward-only, backfill-free, single transaction.
-- Constitution v1.2.1 Principle X (project-scoped isolation): RLS unchanged on
-- `decisions`; `decision_edges` inherits the same scoping semantics via the
-- org_id + decision FK chain.

BEGIN;

-- 1. Decision-outcome + decision-context columns. All defaulted so existing
--    rows end with outcome='unknown', empty arrays, and NULL timestamp — no
--    backfill job needed (FR-003).
ALTER TABLE decisions
  ADD COLUMN IF NOT EXISTS outcome TEXT
    CHECK (outcome IN ('success', 'failed', 'partial', 'unknown'))
    DEFAULT 'unknown',
  ADD COLUMN IF NOT EXISTS outcome_reason TEXT,
  ADD COLUMN IF NOT EXISTS outcome_updated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS alternatives_considered TEXT[] DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS risks TEXT[] DEFAULT '{}';

-- 2. Typed-edges table — populated by Track 5b (#31 EdgeWalker + valis_evolve).
--    ON DELETE CASCADE on both FKs so removing a decision cleans up its edges
--    instead of leaving dangling rows that the BFS walker would have to filter.
CREATE TABLE IF NOT EXISTS decision_edges (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  from_id    UUID NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
  to_id      UUID NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
  type       TEXT NOT NULL
    CHECK (type IN ('supersedes', 'builds_on', 'synthesizes', 'contradicts')),
  reason     TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 3. Indexes for BFS walks both directions (the walker may start from either
--    endpoint of an edge), org-scoped so cross-org scans are impossible.
CREATE INDEX IF NOT EXISTS idx_decision_edges_org_from
  ON decision_edges (org_id, from_id);
CREATE INDEX IF NOT EXISTS idx_decision_edges_org_to
  ON decision_edges (org_id, to_id);

-- 4. RLS — same model as `audit_entries`: members can SELECT edges in their
--    org's projects (via decision membership), service-role writes only. The
--    SELECT policy guards cross-org leakage; INSERTs come from the server
--    with service-role credentials so no auth INSERT policy is exposed.
ALTER TABLE decision_edges ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS decision_edges_select ON decision_edges;
CREATE POLICY decision_edges_select
  ON decision_edges FOR SELECT
  USING (
    org_id IN (
      SELECT m.org_id FROM members m
      WHERE m.id = ((current_setting('request.jwt.claims', true)::json)->>'member_id')::uuid
        AND m.revoked_at IS NULL
    )
  );

COMMIT;
