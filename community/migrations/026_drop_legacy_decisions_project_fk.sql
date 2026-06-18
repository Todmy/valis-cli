-- 026: Drop the legacy FK constraint left over from migration 004.
--
-- Migration 004 added `decisions.project_id_new UUID REFERENCES projects(id)`
-- (line 89) which Postgres auto-named `decisions_project_id_new_fkey`. After
-- the column was renamed to `project_id` (line 107) the constraint kept its
-- original name — Postgres does not rename constraints alongside columns.
--
-- Migration 025 attempted to drop `decisions_project_id_fkey` (the
-- canonical name) and re-add it with ON DELETE CASCADE. The drop was a
-- no-op (Postgres NOTICE: constraint does not exist, skipping), the add
-- succeeded — leaving the table with TWO FKs on the same column:
--   1. decisions_project_id_new_fkey (NO ACTION — legacy, blocking)
--   2. decisions_project_id_fkey     (CASCADE  — created in 025)
-- The NO ACTION rule wins on conflict, so project hard-delete still
-- fails. This migration drops the legacy constraint by its actual name.
--
-- IF EXISTS keeps the migration safe on fresh local DBs where 004 was
-- run cleanly enough that no zombie FK was created.

ALTER TABLE decisions
  DROP CONSTRAINT IF EXISTS decisions_project_id_new_fkey;

COMMENT ON CONSTRAINT decisions_project_id_fkey ON decisions IS
  'CASCADE since 025 + 026: project hard-delete removes all decisions for the project.';
