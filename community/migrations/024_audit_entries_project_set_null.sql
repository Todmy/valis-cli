-- 024: Preserve audit history when a project is hard-deleted.
--
-- Migration 004 added `audit_entries.project_id UUID REFERENCES projects(id)`
-- with the default ON DELETE NO ACTION. That meant deleting a project would
-- fail with a FK violation whenever any audit row referenced it (which is
-- always — `project_created` is the first row written for every project).
--
-- Hard delete is a real user need (empty / abandoned projects pile up and
-- can't currently be removed). Cascading delete onto audit rows would erase
-- compliance history; the safer move is SET NULL so audit rows survive with
-- their context payload but lose the dangling FK.
--
-- The constraint name follows the Postgres default `<table>_<column>_fkey`
-- which is what migration 004 produced. DROP IF EXISTS keeps the migration
-- idempotent across local restores.

ALTER TABLE audit_entries
  DROP CONSTRAINT IF EXISTS audit_entries_project_id_fkey;

ALTER TABLE audit_entries
  ADD CONSTRAINT audit_entries_project_id_fkey
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL;

COMMENT ON COLUMN audit_entries.project_id IS
  'Nullable FK to projects(id). SET NULL on project delete preserves audit '
  'history; context payload retains the original project_id + name.';
