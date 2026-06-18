-- 033-public-kb-read: wire projects.visibility to the read pipeline.
--
-- Background
--   The `projects.visibility` column (TEXT 'private' | 'public', DEFAULT 'private')
--   was added in migration 012 under feature 018 but was never read by any RLS
--   policy or application code path. This migration is the read-side enforcement
--   that turns the column into a real access toggle.
--
-- Effect
--   Authenticated Valis users from ANY org can SELECT decisions and
--   contradictions of a project when that project's visibility = 'public'.
--   Write paths (INSERT / UPDATE / DELETE) remain strictly members-only — no
--   change to write semantics.
--
-- Compatibility
--   The legacy single-policy `FOR ALL` style on `decisions` is replaced with
--   four separate policies so that SELECT can carry the public-flag predicate
--   while writes keep the strict member-only predicate. Existing member
--   behaviour is unchanged.
--
-- Reversibility
--   Fully reversible by replaying the previous migration 004 policy block.
--
-- See specs/033-public-kb-read/{spec.md, data-model.md} for the full design.

-- ============================================================
-- decisions — split FOR ALL into separate SELECT / INSERT / UPDATE / DELETE
-- ============================================================

DROP POLICY IF EXISTS decisions_project_isolation ON decisions;

-- SELECT: caller is a member of the target project's scope OR the target
-- project is public. Members continue to read their own projects exactly as
-- before; non-members gain read access only when the project is public.
CREATE POLICY decisions_select_member_or_public ON decisions
  FOR SELECT
  USING (
    (
      org_id::text = effective_org_id()
      AND (
        project_id::text = effective_project_id()
        OR effective_project_id() IS NULL
      )
    )
    OR EXISTS (
      SELECT 1
      FROM projects p
      WHERE p.id = decisions.project_id
        AND p.visibility = 'public'
    )
  );

-- INSERT: members-only, identical to the predicate from the prior FOR ALL.
CREATE POLICY decisions_insert_member ON decisions
  FOR INSERT
  WITH CHECK (
    org_id::text = effective_org_id()
    AND project_id::text = effective_project_id()
  );

-- UPDATE: members-only.
CREATE POLICY decisions_update_member ON decisions
  FOR UPDATE
  USING (
    org_id::text = effective_org_id()
    AND (
      project_id::text = effective_project_id()
      OR effective_project_id() IS NULL
    )
  )
  WITH CHECK (
    org_id::text = effective_org_id()
    AND project_id::text = effective_project_id()
  );

-- DELETE: members-only.
CREATE POLICY decisions_delete_member ON decisions
  FOR DELETE
  USING (
    org_id::text = effective_org_id()
    AND (
      project_id::text = effective_project_id()
      OR effective_project_id() IS NULL
    )
  );

-- ============================================================
-- contradictions — replace SELECT policy with member-OR-public variant
-- ============================================================

DROP POLICY IF EXISTS contradictions_project_read ON contradictions;

CREATE POLICY contradictions_select_member_or_public ON contradictions
  FOR SELECT
  USING (
    (
      org_id::text = effective_org_id()
      AND (
        project_id::text = effective_project_id()
        OR effective_project_id() IS NULL
      )
    )
    OR EXISTS (
      SELECT 1
      FROM projects p
      WHERE p.id = contradictions.project_id
        AND p.visibility = 'public'
    )
  );

COMMENT ON POLICY decisions_select_member_or_public ON decisions IS
  '033: read predicate combines membership scope OR projects.visibility = ''public''.';

COMMENT ON POLICY contradictions_select_member_or_public ON contradictions IS
  '033: read predicate mirrors decisions_select_member_or_public for contradictions.';
