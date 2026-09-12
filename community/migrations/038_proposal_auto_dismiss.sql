-- 038: project-configurable automatic dismissal of aged proposals.
ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS proposal_auto_dismiss_after_days INTEGER NOT NULL DEFAULT 30;

ALTER TABLE projects
  DROP CONSTRAINT IF EXISTS projects_proposal_auto_dismiss_days_check;

ALTER TABLE projects
  ADD CONSTRAINT projects_proposal_auto_dismiss_days_check
  CHECK (proposal_auto_dismiss_after_days BETWEEN 1 AND 3650);

CREATE INDEX IF NOT EXISTS idx_decisions_proposed_project_created
  ON decisions(project_id, created_at)
  WHERE status = 'proposed';
