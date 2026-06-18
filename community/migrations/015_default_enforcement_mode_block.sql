-- 019-launch-readiness: change projects.enforcement_mode DEFAULT from 'suggest' to 'block'.
--
-- Rationale (per spec 019 US3 / research R-004):
-- The launch-readiness UX hardening shifts the out-of-the-box behavior so that
-- new projects enforce decisions at PR time by default instead of silently
-- logging suggestions. The previous default ('suggest') made the demo feel
-- inert — a new project would never block a PR even when seeded with strong
-- decisions, defeating the wedge.
--
-- Backwards compatibility:
--   - The 'warn' enum value is retained in the CHECK constraint. ~3 pre-launch
--     projects may still be on 'warn'; auto-migration is forbidden by spec
--     (FR-017) so they keep working until an admin opts in via the dashboard.
--   - Existing projects keep their stored enforcement_mode (no UPDATE).
--   - This migration only changes the column DEFAULT for new INSERTs that
--     omit the field.
--
-- API + UI guards (T017, T018, T019) reject explicit 'warn' on new
-- create/PATCH calls; this migration is paired with those changes.

ALTER TABLE projects
  ALTER COLUMN enforcement_mode SET DEFAULT 'block';

COMMENT ON COLUMN projects.enforcement_mode IS
  '019: default enforcement mode for CI checks. Default ''block'' since 019 (was ''suggest'' in 018). Legacy enum value ''warn'' retained for backwards compat with pre-019 projects; new projects cannot select ''warn'' via API or UI.';
