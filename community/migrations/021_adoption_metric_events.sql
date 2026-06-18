-- 021_adoption_metric_events.sql
-- Feature 023-valis-mandatory-context (Phase A): backend event-counter table
-- backing FR-030 aggregate adoption metrics + SC-001/SC-002/SC-009/SC-010.
--
-- Per data-model.md §5: additive, idempotent, single transaction.
-- Append-only events; INSERTs are service-role-only (no auth INSERT policy).
-- SELECT scoping mirrors audit_entries (project membership via project_members).
--
-- Constitution v1.2.1: Principle X (project-scoped isolation) — RLS by project_id.

BEGIN;

-- 1. Event-counter table.
CREATE TABLE IF NOT EXISTS adoption_metric_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  event_type  text NOT NULL CHECK (event_type IN (
                'session_started_with_context',
                'prompt_search_served',
                'prompt_search_hit',
                'prompt_search_miss_threshold',
                'prompt_search_miss_budget',
                'capture_stored_in_session',
                'migration_offered',
                'migration_accepted',
                'migration_declined',
                'telemetry_consent_accepted',
                'telemetry_consent_declined',
                'telemetry_day_30_continued',
                'telemetry_day_30_stopped'
              )),
  count       integer NOT NULL DEFAULT 1 CHECK (count >= 1),
  occurred_at timestamptz NOT NULL DEFAULT now()
);

-- 2. Index for time-series aggregation queries.
CREATE INDEX IF NOT EXISTS idx_adoption_metric_events_project_event_time
  ON adoption_metric_events (project_id, event_type, occurred_at DESC);

-- 3. RLS — SELECT scoped to project members (mirrors audit_entries).
ALTER TABLE adoption_metric_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS adoption_metric_events_select ON adoption_metric_events;
CREATE POLICY adoption_metric_events_select
  ON adoption_metric_events FOR SELECT
  USING (
    project_id IN (
      SELECT pm.project_id FROM project_members pm
      WHERE pm.member_id = ((current_setting('request.jwt.claims', true)::json)->>'member_id')::uuid
    )
  );

-- INSERTs are service-role-only — no auth INSERT policy exposed.

COMMIT;
