-- Feature 045 (Find Gaps — Phase 1 MVP) — additive migration. No destructive change.
--
-- Three new tables back the Analyze-Gaps surface:
--   gap_runs       — one row per Analyze-Gaps click (043 triage_runs pattern:
--                    run row + status polling + one-active-per-project guard).
--   gap_questions  — the persisted lifecycle entity (open/accepted/closed/
--                    dismissed); UNIQUE (project_id, archetype_component) is the
--                    cross-run dedup anchor (FR-019).
--   gap_events     — append-only action log; the Phase-2 flywheel seed (FR-024).
--
-- RLS posture (mirrors decisions/triage_runs):
--   SELECT  — project members (via project_members) or service role.
--   INSERT/UPDATE — service role only; all writes flow through API routes that
--                   authenticate + authorize first (FR-027 = membership check in
--                   the route, not a role-differentiated RLS policy).
--   gap_events — no UPDATE/DELETE policy at all (append-only).
--
-- Explicit GRANTs are MANDATORY per team constraint 7a3b2889 (Supabase Data API
-- enforcement, 2026-10-30): a CREATE TABLE public.* is invisible to supabase-js
-- until granted; RLS policies alone are not sufficient.

-- ============================================================
-- 1. gap_runs
-- ============================================================

CREATE TABLE IF NOT EXISTS gap_runs (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                uuid NOT NULL,
  project_id            uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  started_by            uuid NOT NULL,
  status                text NOT NULL DEFAULT 'running',
  register              text NULL,
  domain                text NULL,
  knowledge_state_hash  text NOT NULL,
  model_calls           integer NOT NULL DEFAULT 0,
  questions_added       integer NOT NULL DEFAULT 0,
  reliability_telemetry real NULL,
  truncated             boolean NOT NULL DEFAULT false,
  error                 text NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  finished_at           timestamptz NULL,
  CONSTRAINT gap_runs_status_chk CHECK (status IN ('running','completed','failed')),
  CONSTRAINT gap_runs_register_chk CHECK (register IS NULL OR register IN ('standard','synthesized'))
);

-- At most one active run per project (duplicate-click guard; 043 precedent).
CREATE UNIQUE INDEX IF NOT EXISTS gap_runs_one_active
  ON gap_runs (project_id)
  WHERE status = 'running';

CREATE INDEX IF NOT EXISTS idx_gap_runs_project_created
  ON gap_runs (project_id, created_at DESC);

-- ============================================================
-- 2. gap_questions
-- ============================================================

CREATE TABLE IF NOT EXISTS gap_questions (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                 uuid NOT NULL,
  project_id             uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  run_id                 uuid NOT NULL REFERENCES gap_runs(id),
  archetype_component    text NOT NULL,
  question               text NOT NULL,
  why_asking             text NOT NULL,
  grounding_decision_ids uuid[] NOT NULL,
  grounding_snapshot     jsonb NOT NULL,
  importance             smallint NOT NULL,
  non_obviousness        smallint NOT NULL,
  register               text NOT NULL,
  state                  text NOT NULL DEFAULT 'open',
  closing_decision_id    uuid NULL REFERENCES decisions(id),
  state_changed_by       uuid NULL,
  state_changed_at       timestamptz NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT gap_questions_importance_chk CHECK (importance BETWEEN 1 AND 5),
  CONSTRAINT gap_questions_non_obviousness_chk CHECK (non_obviousness BETWEEN 1 AND 5),
  CONSTRAINT gap_questions_register_chk CHECK (register IN ('standard','synthesized')),
  CONSTRAINT gap_questions_state_chk CHECK (state IN ('open','accepted','closed','dismissed')),
  CONSTRAINT gap_questions_grounding_nonempty_chk CHECK (cardinality(grounding_decision_ids) > 0)
);

-- No duplicate components across runs (FR-019, SC-009) — the dedup anchor.
CREATE UNIQUE INDEX IF NOT EXISTS gap_questions_project_component_unique
  ON gap_questions (project_id, archetype_component);

CREATE INDEX IF NOT EXISTS idx_gap_questions_project_state
  ON gap_questions (project_id, state);

-- Resurfacing eligibility scan over grounding refs (R4).
CREATE INDEX IF NOT EXISTS idx_gap_questions_grounding
  ON gap_questions USING GIN (grounding_decision_ids);

-- ============================================================
-- 3. gap_events (append-only)
-- ============================================================

CREATE TABLE IF NOT EXISTS gap_events (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id               uuid NOT NULL,
  project_id           uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  question_id          uuid NOT NULL REFERENCES gap_questions(id) ON DELETE CASCADE,
  archetype_component  text NOT NULL,
  action               text NOT NULL,
  knowledge_state_hash text NOT NULL,
  actor_member_id      uuid NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT gap_events_action_chk
    CHECK (action IN ('accept','dismiss','close_decision','close_resolved'))
);

CREATE INDEX IF NOT EXISTS idx_gap_events_project_created
  ON gap_events (project_id, created_at);

-- ============================================================
-- 4. RLS — member SELECT, service-role writes
-- ============================================================

ALTER TABLE gap_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE gap_questions ENABLE ROW LEVEL SECURITY;
ALTER TABLE gap_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS gap_runs_select ON gap_runs;
CREATE POLICY gap_runs_select
  ON gap_runs FOR SELECT
  USING (
    project_id IN (
      SELECT pm.project_id FROM project_members pm
      WHERE pm.member_id = ((current_setting('request.jwt.claims', true)::json)->>'member_id')::uuid
    )
  );

DROP POLICY IF EXISTS gap_questions_select ON gap_questions;
CREATE POLICY gap_questions_select
  ON gap_questions FOR SELECT
  USING (
    project_id IN (
      SELECT pm.project_id FROM project_members pm
      WHERE pm.member_id = ((current_setting('request.jwt.claims', true)::json)->>'member_id')::uuid
    )
  );

DROP POLICY IF EXISTS gap_events_select ON gap_events;
CREATE POLICY gap_events_select
  ON gap_events FOR SELECT
  USING (
    project_id IN (
      SELECT pm.project_id FROM project_members pm
      WHERE pm.member_id = ((current_setting('request.jwt.claims', true)::json)->>'member_id')::uuid
    )
  );

-- INSERT/UPDATE are service-role-only — no auth write policy exposed.
-- gap_events has no UPDATE/DELETE policy at all (append-only by construction).

-- ============================================================
-- 5. GRANTs — required for Data API exposure (constraint 7a3b2889)
-- ============================================================

GRANT SELECT, INSERT, UPDATE, DELETE ON public.gap_runs TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.gap_runs TO service_role;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.gap_questions TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.gap_questions TO service_role;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.gap_events TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.gap_events TO service_role;
