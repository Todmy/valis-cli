-- Migration 004: Multi-Project Support
-- Introduces project-level isolation for decisions, contradictions, and audit.
-- Safe for existing databases with data: creates default project per org,
-- backfills all existing rows, then adds NOT NULL constraints.
--
-- Changes:
--   New table:           projects
--   New table:           project_members
--   ALTER decisions:     project_id TEXT -> UUID FK (three-step deprecation cycle)
--   ALTER contradictions: add project_id UUID FK (backfill from decision_a_id)
--   ALTER audit_entries:  add project_id UUID FK (nullable — org-level actions)
--   ALTER rate_limits:    add project_id UUID (nullable)
--   New indexes:         decisions.project_id, decisions.(project_id,content_hash),
--                        contradictions.(project_id,status),
--                        audit_entries.(project_id,created_at)
--   Expand audit_entries action CHECK for project actions
--   New helper function:  effective_project_id()
--   New/updated RLS:      projects_org_read, project_members_read,
--                         decisions_project_isolation, contradictions_project_read
--   Updated RPC:          search_decisions, get_dashboard_stats, find_contradictions
--   New RPC:              list_member_projects
--   Audit entries for migration

BEGIN;

-- ============================================================
-- 1. New table: projects
-- ============================================================

CREATE TABLE IF NOT EXISTS projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
  invite_code TEXT UNIQUE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- No duplicate project names within an org
  CONSTRAINT projects_org_name_unique UNIQUE (org_id, name)
);

-- Indexes per data-model.md
CREATE INDEX IF NOT EXISTS idx_projects_org_id
  ON projects(org_id);

-- invite_code already has a UNIQUE constraint which creates an index

-- ============================================================
-- 2. New table: project_members
-- ============================================================

CREATE TABLE IF NOT EXISTS project_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  member_id UUID NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('project_admin', 'project_member')),
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- A member can only have one role per project
  CONSTRAINT project_members_unique UNIQUE (project_id, member_id)
);

-- For "list all projects for a member" queries
CREATE INDEX IF NOT EXISTS idx_project_members_member_id
  ON project_members(member_id);

-- ============================================================
-- 3. Create default project per existing org
-- Reuse org's invite_code for the default project.
-- ============================================================

INSERT INTO projects (id, org_id, name, invite_code, created_at)
SELECT
  gen_random_uuid(),
  o.id,
  'default',
  o.invite_code,  -- reuse org's invite code for default project
  now()
FROM orgs o
WHERE NOT EXISTS (
  SELECT 1 FROM projects p WHERE p.org_id = o.id AND p.name = 'default'
);

-- ============================================================
-- 4. Three-step decisions.project_id migration (TEXT -> UUID FK)
-- Step A: Add new UUID column
-- ============================================================

ALTER TABLE decisions
  ADD COLUMN IF NOT EXISTS project_id_new UUID REFERENCES projects(id);

-- ============================================================
-- 5. Backfill decisions with default project
-- ============================================================

UPDATE decisions d
SET project_id_new = p.id
FROM projects p
WHERE p.org_id = d.org_id
  AND p.name = 'default'
  AND d.project_id_new IS NULL;

-- ============================================================
-- 6. Swap columns: drop old TEXT project_id, rename new to project_id
-- ============================================================

ALTER TABLE decisions DROP COLUMN IF EXISTS project_id;
ALTER TABLE decisions RENAME COLUMN project_id_new TO project_id;
ALTER TABLE decisions ALTER COLUMN project_id SET NOT NULL;

-- ============================================================
-- 7. Create project_members for all existing members
-- Org admins become project_admin, members become project_member
-- ============================================================

INSERT INTO project_members (id, project_id, member_id, role, joined_at)
SELECT
  gen_random_uuid(),
  p.id,
  m.id,
  CASE WHEN m.role = 'admin' THEN 'project_admin' ELSE 'project_member' END,
  now()
FROM members m
JOIN projects p ON p.org_id = m.org_id AND p.name = 'default'
WHERE NOT EXISTS (
  SELECT 1 FROM project_members pm
  WHERE pm.project_id = p.id AND pm.member_id = m.id
);

-- ============================================================
-- 8. Add project_id to contradictions (backfill from decision_a_id)
-- ============================================================

ALTER TABLE contradictions
  ADD COLUMN IF NOT EXISTS project_id UUID REFERENCES projects(id);

-- Backfill: resolve project from decision_a_id
UPDATE contradictions c
SET project_id = d.project_id
FROM decisions d
WHERE c.decision_a_id = d.id
  AND c.project_id IS NULL;

ALTER TABLE contradictions ALTER COLUMN project_id SET NOT NULL;

-- ============================================================
-- 9. Add project_id to audit_entries (nullable — org-level actions)
-- ============================================================

ALTER TABLE audit_entries
  ADD COLUMN IF NOT EXISTS project_id UUID REFERENCES projects(id);

-- ============================================================
-- 10. Add project_id to rate_limits (nullable)
-- ============================================================

ALTER TABLE rate_limits
  ADD COLUMN IF NOT EXISTS project_id UUID;

-- ============================================================
-- 11. Indexes
-- ============================================================

-- decisions: project-scoped queries
CREATE INDEX IF NOT EXISTS idx_decisions_project_id
  ON decisions(project_id);

-- decisions: per-project dedup replaces per-org dedup
-- Drop old org-level unique hash index
DROP INDEX IF EXISTS idx_decisions_org_hash;

CREATE UNIQUE INDEX IF NOT EXISTS idx_decisions_project_hash
  ON decisions(project_id, content_hash);

-- contradictions: project-scoped status queries
DROP INDEX IF EXISTS idx_contradictions_org_status;

CREATE INDEX IF NOT EXISTS idx_contradictions_project_status
  ON contradictions(project_id, status);

-- audit_entries: project-scoped timeline (partial — only rows with project_id)
CREATE INDEX IF NOT EXISTS idx_audit_entries_project_created
  ON audit_entries(project_id, created_at DESC)
  WHERE project_id IS NOT NULL;

-- ============================================================
-- 12. Expand audit_entries action CHECK for project actions
-- ============================================================

ALTER TABLE audit_entries
  DROP CONSTRAINT IF EXISTS audit_entries_action_check;
ALTER TABLE audit_entries
  ADD CONSTRAINT audit_entries_action_check CHECK (action IN (
    'decision_stored',
    'decision_deprecated',
    'decision_superseded',
    'decision_promoted',
    'decision_depends_added',
    'member_joined',
    'member_revoked',
    'key_rotated',
    'org_key_rotated',
    'contradiction_detected',
    'contradiction_resolved',
    'decision_pinned',
    'decision_unpinned',
    'decision_enriched',
    'decision_auto_deduped',
    'pattern_synthesized',
    'project_created',
    'project_member_added',
    'project_member_removed',
    'migration_default_project'
  ));

-- ============================================================
-- 13. Helper function: effective_project_id()
-- Resolves project_id from set_config (legacy) or JWT claims.
-- Returns NULL when no project context is set (org-level queries).
-- ============================================================

CREATE OR REPLACE FUNCTION effective_project_id()
RETURNS TEXT
LANGUAGE sql STABLE
AS $$
  SELECT COALESCE(
    NULLIF(current_setting('app.project_id', true), ''),
    (SELECT auth.jwt()->>'project_id')
  );
$$;

-- ============================================================
-- 14. Row Level Security — new tables
-- ============================================================

ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_members ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- 15. RLS Policies
-- ============================================================

-- ------------------------------------------------------------
-- 15a. projects: org-scoped read (members see all projects in their org)
-- ------------------------------------------------------------

CREATE POLICY projects_org_read ON projects
  FOR SELECT
  USING (org_id::text = effective_org_id());

-- Write: service_role only (Edge Functions create projects)

-- ------------------------------------------------------------
-- 15b. project_members: read own project memberships or org admin
-- ------------------------------------------------------------

CREATE POLICY project_members_read ON project_members
  FOR SELECT
  USING (
    member_id::text = (SELECT auth.jwt()->>'sub')
    OR EXISTS (
      SELECT 1 FROM members m
      WHERE m.id::text = (SELECT auth.jwt()->>'sub')
        AND m.role = 'admin'
        AND m.org_id = (
          SELECT p.org_id FROM projects p WHERE p.id = project_members.project_id
        )
    )
  );

-- ------------------------------------------------------------
-- 15c. decisions: project-scoped isolation (replaces org-only policy)
-- ------------------------------------------------------------

DROP POLICY IF EXISTS decisions_org_isolation ON decisions;

CREATE POLICY decisions_project_isolation ON decisions
  FOR ALL
  USING (
    org_id::text = effective_org_id()
    AND (
      project_id::text = effective_project_id()
      OR effective_project_id() IS NULL  -- legacy clients without project context
    )
  )
  WITH CHECK (
    org_id::text = effective_org_id()
    AND project_id::text = effective_project_id()
  );

-- ------------------------------------------------------------
-- 15d. contradictions: project-scoped (replaces org-only policy)
-- ------------------------------------------------------------

DROP POLICY IF EXISTS contradictions_org_read ON contradictions;

CREATE POLICY contradictions_project_read ON contradictions
  FOR SELECT
  USING (
    org_id::text = effective_org_id()
    AND (
      project_id::text = effective_project_id()
      OR effective_project_id() IS NULL
    )
  );

-- ============================================================
-- 16. RPC Functions (updated + new)
-- ============================================================

-- ------------------------------------------------------------
-- search_decisions: now accepts p_project_id
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION search_decisions(
  p_org_id UUID,
  p_project_id UUID,
  p_query TEXT,
  p_type TEXT DEFAULT NULL,
  p_limit INTEGER DEFAULT 10
)
RETURNS SETOF decisions
LANGUAGE sql STABLE
AS $$
  SELECT *
  FROM decisions
  WHERE org_id = p_org_id
    AND project_id = p_project_id
    AND (p_type IS NULL OR type = p_type)
    AND (
      detail ILIKE '%' || p_query || '%'
      OR summary ILIKE '%' || p_query || '%'
    )
  ORDER BY created_at DESC
  LIMIT p_limit;
$$;

-- ------------------------------------------------------------
-- get_dashboard_stats: now accepts p_project_id
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION get_dashboard_stats(
  p_org_id UUID,
  p_project_id UUID
)
RETURNS JSON
LANGUAGE sql STABLE
AS $$
  SELECT json_build_object(
    'total_decisions', (SELECT count(*) FROM decisions WHERE org_id = p_org_id AND project_id = p_project_id),
    'by_type', (
      SELECT json_object_agg(type, cnt)
      FROM (SELECT type, count(*) as cnt FROM decisions WHERE org_id = p_org_id AND project_id = p_project_id GROUP BY type) t
    ),
    'by_author', (
      SELECT json_object_agg(author, cnt)
      FROM (SELECT author, count(*) as cnt FROM decisions WHERE org_id = p_org_id AND project_id = p_project_id GROUP BY author) a
    ),
    'pending_count', (SELECT count(*) FROM decisions WHERE org_id = p_org_id AND project_id = p_project_id AND type = 'pending')
  );
$$;

-- ------------------------------------------------------------
-- find_contradictions: now accepts p_project_id
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION find_contradictions(
  p_org_id UUID,
  p_project_id UUID,
  p_affects TEXT[]
)
RETURNS SETOF decisions
LANGUAGE sql STABLE
AS $$
  SELECT *
  FROM decisions
  WHERE org_id = p_org_id
    AND project_id = p_project_id
    AND status = 'active'
    AND affects && p_affects
  ORDER BY created_at DESC;
$$;

-- ------------------------------------------------------------
-- list_member_projects: new — returns all projects for a member
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION list_member_projects(
  p_member_id UUID
)
RETURNS TABLE (
  project_id UUID,
  project_name TEXT,
  project_role TEXT,
  org_id UUID,
  org_name TEXT,
  decision_count BIGINT
)
LANGUAGE sql STABLE
AS $$
  SELECT
    p.id AS project_id,
    p.name AS project_name,
    pm.role AS project_role,
    o.id AS org_id,
    o.name AS org_name,
    (SELECT count(*) FROM decisions d WHERE d.project_id = p.id) AS decision_count
  FROM project_members pm
  JOIN projects p ON p.id = pm.project_id
  JOIN orgs o ON o.id = p.org_id
  WHERE pm.member_id = p_member_id
  ORDER BY p.name;
$$;

-- ============================================================
-- 17. Audit entries for the migration
-- ============================================================

INSERT INTO audit_entries (id, org_id, member_id, action, target_type, target_id, new_state, reason)
SELECT
  gen_random_uuid(),
  p.org_id,
  (SELECT m.id FROM members m WHERE m.org_id = p.org_id AND m.role = 'admin' LIMIT 1),
  'migration_default_project',
  'org',
  p.org_id,
  json_build_object('project_id', p.id, 'project_name', p.name)::jsonb,
  'Automatic migration: created default project for multi-project support'
FROM projects p
WHERE p.name = 'default';

COMMIT;
