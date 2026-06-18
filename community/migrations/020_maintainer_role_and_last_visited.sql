-- 020_maintainer_role_and_last_visited.sql
-- Feature 022-scoped-ui: add 'project_maintainer' role + last-visited tracking.
--
-- Per data-model.md / research.md R3: additive, idempotent, single transaction.
-- The migration extends project_members with a fourth role and a per-membership
-- "last visited" timestamp used to resolve the active project for the cross-project
-- search default scope and the top-bar context badge.
--
-- Constitution v1.2.1 (PATCH): Principle X enumerates four RBAC levels.

BEGIN;

-- 1. Extend role CHECK to include 'project_maintainer' (member-equivalent + Curate visibility).
ALTER TABLE project_members
  DROP CONSTRAINT IF EXISTS project_members_role_check;

ALTER TABLE project_members
  ADD CONSTRAINT project_members_role_check
  CHECK (role IN ('project_admin', 'project_member', 'project_maintainer'));

-- 2. Per-membership "last visited" pointer; nullable until the user actually visits.
ALTER TABLE project_members
  ADD COLUMN IF NOT EXISTS last_visited_at TIMESTAMPTZ NULL;

-- 3. Index for fast active-project resolution (max last_visited_at per member).
CREATE INDEX IF NOT EXISTS project_members_last_visited_idx
  ON project_members (member_id, last_visited_at DESC NULLS LAST);

COMMIT;
