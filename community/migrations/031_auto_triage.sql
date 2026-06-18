-- Feature 043 (Auto-triage) — additive migration. No destructive change.
-- triage_runs: operational record of a background assessment pass over a
-- project's proposed backlog (source of truth for progress; survives reload).
-- decisions.applied_by_run_id: links a decision to the run that auto-applied it
-- (used by US2 audit list + whole-batch undo; added now, written by US2).

CREATE TABLE IF NOT EXISTS triage_runs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id        uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  org_id            uuid NOT NULL,
  started_by        uuid NOT NULL,
  status            text NOT NULL DEFAULT 'running',
  auto_apply        boolean NOT NULL DEFAULT false,
  auto_apply_floor  text NOT NULL DEFAULT 'decisive',
  total             integer NOT NULL DEFAULT 0,
  assessed          integer NOT NULL DEFAULT 0,
  auto_applied      integer NOT NULL DEFAULT 0,
  left_for_manual   integer NOT NULL DEFAULT 0,
  degraded          integer NOT NULL DEFAULT 0,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  finished_at       timestamptz NULL,
  CONSTRAINT triage_runs_status_chk
    CHECK (status IN ('running','completed','cancelled','failed','recoverable'))
);

ALTER TABLE decisions
  ADD COLUMN IF NOT EXISTS applied_by_run_id uuid NULL REFERENCES triage_runs(id) ON DELETE SET NULL;

-- At most one active run per project (FR-004) — the DB-level race backstop.
CREATE UNIQUE INDEX IF NOT EXISTS idx_triage_runs_one_active
  ON triage_runs (project_id)
  WHERE status IN ('running','recoverable');

CREATE INDEX IF NOT EXISTS idx_triage_runs_project_status
  ON triage_runs (project_id, status);

CREATE INDEX IF NOT EXISTS idx_decisions_applied_by_run
  ON decisions (applied_by_run_id)
  WHERE applied_by_run_id IS NOT NULL;

-- RLS: triage_runs is accessed ONLY server-side via the service role (the
-- /api/triage-runs route, behind the 042 maintainer/admin gate). Clients never
-- query it directly. Enable RLS with no policy → no direct client access; the
-- service role bypasses RLS for the API path. (No member-read policy is added
-- to avoid coupling this migration to project_members column / JWT-claim names.)
ALTER TABLE triage_runs ENABLE ROW LEVEL SECURITY;
