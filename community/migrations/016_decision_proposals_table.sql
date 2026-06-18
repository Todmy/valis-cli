-- 016: Add `decision_proposals` table for US5 (Decision Proposals Queue).
--
-- Per spec 019 FR-026..FR-032 + data-model.md §7. Surfaces codifiable
-- patterns the LLM detector finds in PRs that don't match any captured
-- decision. Lives in queue state until an admin captures (turns into a
-- formal decision) or dismisses (closes with audit trail).
--
-- T073 (analyze patch I3) — pgvector is required for the HNSW index on
-- summary_embedding. CREATE EXTENSION IF NOT EXISTS is idempotent and
-- zero-cost when the extension is already enabled.

CREATE EXTENSION IF NOT EXISTS vector;

-- Lifecycle state enum. Both terminal states are write-once (FR-040).
CREATE TYPE decision_proposal_state AS ENUM ('active', 'captured', 'dismissed');

CREATE TABLE decision_proposals (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id            uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,

  -- Proposal content
  summary               text NOT NULL,
  rationale             text,
  file_paths            jsonb NOT NULL DEFAULT '[]'::jsonb,
  pr_urls               jsonb NOT NULL DEFAULT '[]'::jsonb,
  detected_pattern      text,

  -- Lifecycle
  state                 decision_proposal_state NOT NULL DEFAULT 'active',
  created_at            timestamptz NOT NULL DEFAULT now(),

  -- Captured (state='captured') — link to the decision that was created
  captured_decision_id  uuid REFERENCES decisions(id) ON DELETE SET NULL,
  captured_at           timestamptz,
  captured_by           uuid REFERENCES members(id) ON DELETE SET NULL,

  -- Dismissed (state='dismissed') — admin closed without capturing
  dismissed_at          timestamptz,
  dismissed_by          uuid REFERENCES members(id) ON DELETE SET NULL,
  dismissed_reason      text,

  -- Provenance
  source_audit_id       uuid REFERENCES audit_entries(id) ON DELETE SET NULL,
  source_check_run_id   uuid,

  -- Embedding for dedup (FR-031). bge-m3 (1024-dim) — only populated
  -- after Deploy 2 ships. NULL on rows inserted before Deploy 2; the
  -- detection path falls back to string-similarity in that window.
  summary_embedding     vector(1024),

  -- Lifecycle invariants enforced at the DB layer.
  CONSTRAINT capture_consistency
    CHECK ((state = 'captured') = (captured_decision_id IS NOT NULL AND captured_at IS NOT NULL)),
  CONSTRAINT dismiss_consistency
    CHECK ((state = 'dismissed') = (dismissed_at IS NOT NULL))
);

-- Hot query: list proposals for a project filtered by state. Powers the
-- dashboard Proposals tab (FR-028).
CREATE INDEX idx_decision_proposals_project_state
  ON decision_proposals(project_id, state);

-- Reverse-chronological per-project listing (also used for the FR-039
-- cap-pressure eviction query — `ORDER BY created_at ASC LIMIT 1`).
CREATE INDEX idx_decision_proposals_project_created
  ON decision_proposals(project_id, created_at DESC);

-- Partial HNSW index on the embedding for fast dedup (FR-031). Only
-- active proposals participate in dedup, so the index stays small.
-- Cosine similarity matches the threshold semantics in data-model.md §7.
CREATE INDEX idx_decision_proposals_summary_embedding
  ON decision_proposals USING hnsw (summary_embedding vector_cosine_ops)
  WHERE state = 'active';

COMMENT ON TABLE decision_proposals IS
  '019/US5 — queued proposals from the LLM detector. Lifecycle: active → captured | dismissed. Both terminal states are write-once. Dedup against active rows happens BEFORE insert per data-model.md §7.';
COMMENT ON COLUMN decision_proposals.summary_embedding IS
  'bge-m3 1024-dim embedding for dedup. NULL on rows inserted before Deploy 2 ships; detection path falls back to string-similarity until populated.';
COMMENT ON COLUMN decision_proposals.state IS
  'Lifecycle state. INSERT defaults to ''active''. Transitions to ''captured'' or ''dismissed'' are terminal. FR-040 escape-hatch (re-surfacing dismissed patterns) creates a NEW row with predecessor_proposal_id (added in migration 018).';
