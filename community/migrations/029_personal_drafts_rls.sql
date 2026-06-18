-- 034-unified-capture-policy: per-user personal-drafts projects with strict RLS.
--
-- Background
--   FR-008 / FR-009 require that `valis_store` succeed when the caller is
--   in a directory without `.valis.json`, by writing to the caller's
--   personal-drafts default project. FR-017 (Q2 clarification) mandates
--   strict per-user RLS — even org admins MUST NOT read other members'
--   personal-drafts.
--
-- Schema changes (additive)
--   1. projects.is_personal_drafts BOOLEAN NOT NULL DEFAULT FALSE
--   2. projects.owner_member_id    UUID NULL REFERENCES members(id)
--   3. CHECK: personal-drafts rows MUST have owner_member_id
--   4. Partial UNIQUE: one personal-drafts per (org, member)
--   5. Restructure name uniqueness: keep org-wide team uniqueness, allow
--      multiple members to share the same display name in personal-drafts.
--
-- Spec deviation from data-model.md (logged here for traceability)
--   data-model.md describes a `slug` column on `projects`. The live schema
--   uses `name` (per migration 004), there is no `slug`. This migration
--   adopts the implementation reality:
--     * `name` carries the human-readable display "Personal Drafts"
--     * `is_personal_drafts = TRUE` is the routing flag
--     * CLI/server code routes `--project personal-drafts` (the literal
--       string used in CLI args) to the caller's row via owner_member_id.
--
-- RLS extension
--   `decisions` and `audit_entries` policies extended so that a row whose
--   parent project has is_personal_drafts = TRUE is visible/writable only
--   to owner_member_id = caller. Team projects are unaffected.
--
-- Reversibility
--   Reversible by dropping the two new columns + the two new indexes and
--   restoring the original projects_org_name_unique. The replacement
--   partial unique constraint covers the same legacy uniqueness intent.
--
-- See specs/034-unified-capture-policy/{spec.md, data-model.md} for the
-- full design.

-- ============================================================
-- 1. New columns on projects
-- ============================================================

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS is_personal_drafts BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS owner_member_id UUID NULL
  REFERENCES members(id) ON DELETE CASCADE;

-- Personal-drafts rows MUST have an owner; team projects MUST NOT.
ALTER TABLE projects
  DROP CONSTRAINT IF EXISTS projects_personal_drafts_owner_consistency;
ALTER TABLE projects
  ADD CONSTRAINT projects_personal_drafts_owner_consistency
  CHECK (
    (is_personal_drafts = FALSE AND owner_member_id IS NULL)
    OR (is_personal_drafts = TRUE AND owner_member_id IS NOT NULL)
  );

-- ============================================================
-- 2. Uniqueness restructure
-- ============================================================

-- Legacy: UNIQUE (org_id, name) blocked multiple members from sharing the
-- "Personal Drafts" display name. Replace with two partial uniques:
--   * Team projects: per-org name uniqueness (unchanged semantics).
--   * Personal-drafts: one per (org, owner_member_id).
-- Both are partial unique indexes; together they cover the legacy intent
-- while permitting the new pattern.

ALTER TABLE projects
  DROP CONSTRAINT IF EXISTS projects_org_name_unique;

CREATE UNIQUE INDEX IF NOT EXISTS projects_org_name_team_unique
  ON projects (org_id, name)
  WHERE is_personal_drafts = FALSE;

CREATE UNIQUE INDEX IF NOT EXISTS projects_personal_drafts_owner_unique
  ON projects (org_id, owner_member_id)
  WHERE is_personal_drafts = TRUE;

-- Fast lookup for "get this member's personal-drafts project" at login.
CREATE INDEX IF NOT EXISTS projects_personal_drafts_lookup_idx
  ON projects (owner_member_id)
  WHERE is_personal_drafts = TRUE;

-- ============================================================
-- 3. RLS extension on decisions
-- ============================================================
--
-- The existing decisions_select_member_or_public policy (migration 023)
-- already filters team-project access via org/project membership and
-- handles the public-KB case. We layer the personal-drafts predicate as
-- a separate policy that DENIES read of personal-drafts rows owned by
-- anyone other than the caller. PostgreSQL combines policies with OR
-- for SELECT — to enforce a strict deny, we use a RESTRICTIVE policy.

DROP POLICY IF EXISTS decisions_personal_drafts_owner_only ON decisions;
CREATE POLICY decisions_personal_drafts_owner_only ON decisions
  AS RESTRICTIVE
  FOR ALL
  USING (
    NOT EXISTS (
      SELECT 1 FROM projects p
      WHERE p.id = decisions.project_id
        AND p.is_personal_drafts = TRUE
        AND p.owner_member_id::text <> COALESCE(
          (auth.jwt() ->> 'member_id'),
          ''
        )
    )
  )
  WITH CHECK (
    NOT EXISTS (
      SELECT 1 FROM projects p
      WHERE p.id = decisions.project_id
        AND p.is_personal_drafts = TRUE
        AND p.owner_member_id::text <> COALESCE(
          (auth.jwt() ->> 'member_id'),
          ''
        )
    )
  );

COMMENT ON POLICY decisions_personal_drafts_owner_only ON decisions IS
  'FR-017: personal-drafts entries readable/writable only by owner. No admin override.';

-- ============================================================
-- 4. RLS extension on audit_entries
-- ============================================================
--
-- Q6 / FR-017 extension: the audit_entries row written by FR-011 bind
-- (promotion stub) lives in personal-drafts and MUST inherit the same
-- per-owner restriction so that no admin tooling can enumerate
-- "what was promoted from whose drafts".

DROP POLICY IF EXISTS audit_entries_personal_drafts_owner_only ON audit_entries;
CREATE POLICY audit_entries_personal_drafts_owner_only ON audit_entries
  AS RESTRICTIVE
  FOR ALL
  USING (
    NOT EXISTS (
      SELECT 1 FROM projects p
      WHERE p.id = audit_entries.project_id
        AND p.is_personal_drafts = TRUE
        AND p.owner_member_id::text <> COALESCE(
          (auth.jwt() ->> 'member_id'),
          ''
        )
    )
  )
  WITH CHECK (
    NOT EXISTS (
      SELECT 1 FROM projects p
      WHERE p.id = audit_entries.project_id
        AND p.is_personal_drafts = TRUE
        AND p.owner_member_id::text <> COALESCE(
          (auth.jwt() ->> 'member_id'),
          ''
        )
    )
  );

COMMENT ON POLICY audit_entries_personal_drafts_owner_only ON audit_entries IS
  'FR-017 / Q6: promotion audit rows visible only to drafts owner.';

-- ============================================================
-- 5. RLS extension on projects
-- ============================================================
--
-- A member should not be able to see other members' personal-drafts
-- PROJECT rows either (the row itself, not just its decisions). Without
-- this, list-projects would leak the existence of foreign drafts.

DROP POLICY IF EXISTS projects_personal_drafts_owner_only ON projects;
CREATE POLICY projects_personal_drafts_owner_only ON projects
  AS RESTRICTIVE
  FOR ALL
  USING (
    NOT (
      is_personal_drafts = TRUE
      AND owner_member_id::text <> COALESCE(
        (auth.jwt() ->> 'member_id'),
        ''
      )
    )
  )
  WITH CHECK (
    NOT (
      is_personal_drafts = TRUE
      AND owner_member_id::text <> COALESCE(
        (auth.jwt() ->> 'member_id'),
        ''
      )
    )
  );

COMMENT ON POLICY projects_personal_drafts_owner_only ON projects IS
  'FR-017: personal-drafts project rows are invisible to non-owners.';

-- ============================================================
-- 6. Verification queries (run manually post-deploy)
-- ============================================================
--
-- SELECT count(*) FROM projects WHERE is_personal_drafts = TRUE;
--   -- expected: 0 immediately after migration (rows are created lazily
--   --           at first `valis login`).
--
-- SELECT
--   indexname,
--   pg_get_indexdef(indexrelid)
-- FROM pg_indexes
-- WHERE tablename = 'projects'
--   AND indexname LIKE '%personal_drafts%';
--   -- expected: two partial unique indexes + one btree lookup index.
