-- 025: Cascade project delete onto decisions + contradictions.
--
-- Migration 004 added the project_id FK with the default NO ACTION on
-- both tables, which combined with migration 024's SET NULL on
-- audit_entries gave us a half-cascade: members / proposals / metrics
-- got cleaned up automatically but a project with even one decision
-- still blocked deletion at the DB level.
--
-- The route's first delivery papered over this with a 409
-- project_not_empty guard, but in practice projects accumulate
-- hundreds of decisions over time — asking the user to remove them
-- one-by-one before deleting a project is not a real workflow.
--
-- Cascade + typed-name confirmation + visible-counts preview is the
-- same contract GitHub repo delete and Supabase project delete use.
-- The destructive intent is captured at the API/UI layer (server
-- re-validates confirm_name === project.name); the DB just executes.
--
-- Idempotent — DROP IF EXISTS / ADD CONSTRAINT both tolerate reruns.

ALTER TABLE decisions
  DROP CONSTRAINT IF EXISTS decisions_project_id_fkey;
ALTER TABLE decisions
  ADD CONSTRAINT decisions_project_id_fkey
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;

ALTER TABLE contradictions
  DROP CONSTRAINT IF EXISTS contradictions_project_id_fkey;
ALTER TABLE contradictions
  ADD CONSTRAINT contradictions_project_id_fkey
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;

COMMENT ON CONSTRAINT decisions_project_id_fkey ON decisions IS
  'CASCADE since 025: project hard-delete removes all decisions for the project. '
  'decision_edges, audit_entries(decision target) follow via their own CASCADEs.';
COMMENT ON CONSTRAINT contradictions_project_id_fkey ON contradictions IS
  'CASCADE since 025: project hard-delete removes all contradictions for the project.';
