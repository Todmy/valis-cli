-- 018-ci-enforcement: merge-gate schema additions.
--
-- Fully additive, backward-compatible:
--   - 2 new columns on projects   (enforcement_mode, visibility)
--   - 3 new columns on decisions  (violation_count, last_violated_at, origin_artifact)
--   - 1 new table                 (project_scoped_tokens)
--   - 5 new audit_entries.action values (ci_check_run, ack, override,
--       override_denied, project_settings_change) — no schema change, just new
--       valid values for the existing action text column.
--
-- No backfill: pre-018 decisions carry violation_count=0, last_violated_at=NULL,
-- origin_artifact=NULL by DEFAULT semantics. New captures (post-deploy) populate
-- origin_artifact at store time via the capture pipeline.

-- Extend projects table ------------------------------------------------------

ALTER TABLE projects
  ADD COLUMN enforcement_mode TEXT NOT NULL DEFAULT 'suggest'
    CHECK (enforcement_mode IN ('block', 'warn', 'suggest')),
  ADD COLUMN visibility TEXT NOT NULL DEFAULT 'private'
    CHECK (visibility IN ('private', 'public'));

COMMENT ON COLUMN projects.enforcement_mode IS
  '018: default enforcement mode for CI checks. Overridable per-repo via .valis.yaml.';
COMMENT ON COLUMN projects.visibility IS
  '018: private projects return 404 on public /decisions/{id} pages to non-members.';

-- Extend decisions table -----------------------------------------------------

ALTER TABLE decisions
  ADD COLUMN violation_count INTEGER NOT NULL DEFAULT 0 CHECK (violation_count >= 0),
  ADD COLUMN last_violated_at TIMESTAMPTZ NULL,
  ADD COLUMN origin_artifact TEXT NULL;

CREATE INDEX idx_decisions_most_violated
  ON decisions (project_id, violation_count DESC)
  WHERE status = 'active' AND violation_count > 0;

COMMENT ON COLUMN decisions.violation_count IS
  '018: lifetime count of unique (PR, commit, decision) violation events. Monotonically non-decreasing.';
COMMENT ON COLUMN decisions.last_violated_at IS
  '018: timestamp of most recent violation event. NULL iff violation_count=0.';
COMMENT ON COLUMN decisions.origin_artifact IS
  '018: commit SHA, PR URL, or MCP session ID captured at store time. NULL for pre-018 decisions (no backfill).';

-- Project-scoped tokens table -----------------------------------------------

CREATE TABLE project_scoped_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  issued_by UUID NOT NULL REFERENCES members(id),
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  prefix TEXT NOT NULL,
  scopes JSONB NOT NULL DEFAULT '{"check":true}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ
);

CREATE INDEX idx_project_tokens_active
  ON project_scoped_tokens (project_id)
  WHERE revoked_at IS NULL;

COMMENT ON TABLE project_scoped_tokens IS
  '018: long-lived, rotatable tokens scoped to a single project. Used by CI Actions.';
COMMENT ON COLUMN project_scoped_tokens.token_hash IS
  'SHA-256 hex of the full token string (format: vls_prj_<16>_<32>). Lookup is O(1) via UNIQUE index.';
COMMENT ON COLUMN project_scoped_tokens.prefix IS
  'First 8 chars of the secret half. Displayed in UI for identification; never reveals the full token.';
COMMENT ON COLUMN project_scoped_tokens.revoked_at IS
  'Non-null = immediately invalid. Rotation = revoke old + issue new.';

-- RLS on project_scoped_tokens ----------------------------------------------

ALTER TABLE project_scoped_tokens ENABLE ROW LEVEL SECURITY;

-- Read: any project_admin of the token's project.
CREATE POLICY project_scoped_tokens_admin_read ON project_scoped_tokens
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM project_members
      WHERE project_members.project_id = project_scoped_tokens.project_id
        AND project_members.member_id = (current_setting('request.jwt.claims', true)::jsonb->>'member_id')::uuid
        AND project_members.role = 'project_admin'
    )
  );

-- Insert: project_admin issuing for a project they admin.
CREATE POLICY project_scoped_tokens_admin_insert ON project_scoped_tokens
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM project_members
      WHERE project_members.project_id = project_scoped_tokens.project_id
        AND project_members.member_id = (current_setting('request.jwt.claims', true)::jsonb->>'member_id')::uuid
        AND project_members.role = 'project_admin'
    )
  );

-- Update: project_admin can revoke (set revoked_at) on their project's tokens.
CREATE POLICY project_scoped_tokens_admin_update ON project_scoped_tokens
  FOR UPDATE USING (
    EXISTS (
      SELECT 1 FROM project_members
      WHERE project_members.project_id = project_scoped_tokens.project_id
        AND project_members.member_id = (current_setting('request.jwt.claims', true)::jsonb->>'member_id')::uuid
        AND project_members.role = 'project_admin'
    )
  );

-- Per-project daily check budget (FR-013) --------------------------------------
--
-- Kept distinct from the existing rate_limits table because rate_limits is
-- keyed by (org_id, day) and extending it with a UNIQUE (project_id, day)
-- would risk regressing store/search accounting. New table has clean
-- project-scoped PK and the atomic debit function returns the post-increment
-- count in one round-trip so the /api/check hot path does not need a
-- follow-up SELECT.

CREATE TABLE project_check_budget (
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  day DATE NOT NULL DEFAULT CURRENT_DATE,
  count INTEGER NOT NULL DEFAULT 0 CHECK (count >= 0),
  PRIMARY KEY (project_id, day)
);

CREATE INDEX idx_project_check_budget_day ON project_check_budget (day);

COMMENT ON TABLE project_check_budget IS
  '018: per-project daily /api/check call counter. Free tier cap = 100/day; paid tiers soft-warned over fair-use ceilings.';

CREATE OR REPLACE FUNCTION debit_check_budget(p_project_id UUID)
RETURNS INTEGER AS $$
DECLARE
  v_count INTEGER;
BEGIN
  INSERT INTO project_check_budget (project_id, day, count)
  VALUES (p_project_id, CURRENT_DATE, 1)
  ON CONFLICT (project_id, day) DO UPDATE
    SET count = project_check_budget.count + 1
  RETURNING count INTO v_count;
  RETURN v_count;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION debit_check_budget IS
  '018: atomic increment + read of today''s check count for a project. Returns the post-increment value.';
