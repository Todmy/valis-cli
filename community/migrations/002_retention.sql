-- Migration 002: Retention, Collaboration & Enterprise Readiness
-- Additive only — no columns removed, no types changed.
--
-- Changes:
--   ALTER members:       add api_key, revoked_at
--   ALTER decisions:     add replaces, depends_on, status_changed_by/at, status_reason
--   New table:           audit_entries
--   New table:           contradictions
--   New RLS policies:    dual-mode (legacy set_config OR JWT auth.jwt())
--   New RPC functions:   find_contradictions, get_audit_trail, get_lifecycle_history

BEGIN;

-- ============================================================
-- 1. ALTER members
-- ============================================================

-- Per-member API key (format: tmm_ + 32 hex chars). Null for legacy members.
ALTER TABLE members
  ADD COLUMN IF NOT EXISTS api_key TEXT UNIQUE,
  ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMPTZ;

-- Partial unique index on api_key (only index non-null values)
CREATE UNIQUE INDEX IF NOT EXISTS idx_members_api_key
  ON members(api_key)
  WHERE api_key IS NOT NULL;

-- ============================================================
-- 2. ALTER decisions
-- ============================================================

-- replaces: pointer to the decision this one supersedes
ALTER TABLE decisions
  ADD COLUMN IF NOT EXISTS replaces UUID REFERENCES decisions(id),
  ADD COLUMN IF NOT EXISTS depends_on UUID[] DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS status_changed_by TEXT,
  ADD COLUMN IF NOT EXISTS status_changed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS status_reason TEXT;

-- Index for reverse lookup: "what decisions replaced this one?"
CREATE INDEX IF NOT EXISTS idx_decisions_replaces
  ON decisions(replaces)
  WHERE replaces IS NOT NULL;

-- ============================================================
-- 3. New table: audit_entries
-- ============================================================

CREATE TABLE IF NOT EXISTS audit_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  member_id UUID NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL CHECK (target_type IN ('decision', 'member', 'org')),
  target_id UUID NOT NULL,
  previous_state JSONB,
  new_state JSONB,
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Enforce a closed set of audit actions
  CONSTRAINT audit_entries_action_check CHECK (action IN (
    'decision_stored',
    'decision_deprecated',
    'decision_superseded',
    'decision_promoted',
    'decision_depends_added',
    'member_joined',
    'member_revoked',
    'key_rotated',
    'org_key_rotated',
    'contradiction_detected',
    'contradiction_resolved'
  ))
);

-- Primary query pattern: chronological audit trail per org
CREATE INDEX IF NOT EXISTS idx_audit_entries_org_created
  ON audit_entries(org_id, created_at DESC);

-- ============================================================
-- 4. New table: contradictions
-- ============================================================

CREATE TABLE IF NOT EXISTS contradictions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  decision_a_id UUID NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
  decision_b_id UUID NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
  overlap_areas TEXT[] NOT NULL,
  similarity_score REAL CHECK (similarity_score IS NULL OR (similarity_score BETWEEN 0.0 AND 1.0)),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  resolved_by UUID REFERENCES members(id),
  resolved_at TIMESTAMPTZ,
  detected_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Enforce ordered pairs to prevent (A,B) and (B,A) duplicates
  CONSTRAINT contradictions_ordered_pair CHECK (decision_a_id < decision_b_id),
  -- Unique constraint on the ordered pair
  CONSTRAINT contradictions_pair_unique UNIQUE (decision_a_id, decision_b_id)
);

-- Primary query pattern: open contradictions per org (dashboard)
CREATE INDEX IF NOT EXISTS idx_contradictions_org_status
  ON contradictions(org_id, status);

-- ============================================================
-- 5. Row Level Security — new tables
-- ============================================================

ALTER TABLE audit_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE contradictions ENABLE ROW LEVEL SECURITY;

-- ------------------------------------------------------------
-- Helper: resolve org_id from legacy set_config OR JWT claims.
-- Returns the effective org_id text, or NULL if neither is set.
-- Used by all dual-mode RLS policies below.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION effective_org_id()
RETURNS TEXT
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(
    NULLIF(current_setting('app.org_id', true), ''),
    (SELECT auth.jwt()->>'org_id')
  );
$$;

-- ------------------------------------------------------------
-- 5a. audit_entries policies
-- ------------------------------------------------------------

-- Read: any authenticated member in the org (legacy OR JWT)
CREATE POLICY audit_entries_org_read ON audit_entries
  FOR SELECT
  USING (org_id::text = effective_org_id());

-- Write: service_role or legacy set_config (Edge Functions write audits)
CREATE POLICY audit_entries_org_write ON audit_entries
  FOR INSERT
  WITH CHECK (org_id::text = effective_org_id());

-- ------------------------------------------------------------
-- 5b. contradictions policies
-- ------------------------------------------------------------

-- Read: any authenticated member in the org (legacy OR JWT)
CREATE POLICY contradictions_org_read ON contradictions
  FOR SELECT
  USING (org_id::text = effective_org_id());

-- Write: service_role or legacy set_config (Edge Functions create/resolve)
CREATE POLICY contradictions_org_write ON contradictions
  FOR INSERT
  WITH CHECK (org_id::text = effective_org_id());

-- Update (for resolving contradictions)
CREATE POLICY contradictions_org_update ON contradictions
  FOR UPDATE
  USING (org_id::text = effective_org_id())
  WITH CHECK (org_id::text = effective_org_id());

-- ------------------------------------------------------------
-- 5c. Update existing table policies for dual-mode auth
-- ------------------------------------------------------------

-- Drop and recreate existing policies to support both legacy and JWT.
-- decisions
DROP POLICY IF EXISTS decisions_org_isolation ON decisions;
CREATE POLICY decisions_org_isolation ON decisions
  FOR ALL
  USING (org_id::text = effective_org_id())
  WITH CHECK (org_id::text = effective_org_id());

-- members
DROP POLICY IF EXISTS members_org_isolation ON members;
CREATE POLICY members_org_isolation ON members
  FOR ALL
  USING (org_id::text = effective_org_id())
  WITH CHECK (org_id::text = effective_org_id());

-- rate_limits
DROP POLICY IF EXISTS rate_limits_org_isolation ON rate_limits;
CREATE POLICY rate_limits_org_isolation ON rate_limits
  FOR ALL
  USING (org_id::text = effective_org_id())
  WITH CHECK (org_id::text = effective_org_id());

-- ============================================================
-- 6. RPC Functions
-- ============================================================

-- ------------------------------------------------------------
-- find_contradictions: returns active decisions with overlapping
-- affects areas. Used by contradiction detection on store.
-- (from Agent A: includes ORDER BY created_at DESC)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION find_contradictions(
  p_org_id UUID,
  p_affects TEXT[]
)
RETURNS SETOF decisions
LANGUAGE sql
STABLE
AS $$
  SELECT *
  FROM decisions
  WHERE org_id = p_org_id
    AND status = 'active'
    AND affects && p_affects
  ORDER BY created_at DESC;
$$;

-- ------------------------------------------------------------
-- get_audit_trail: returns the most recent audit entries for an
-- org, ordered by created_at descending. Default limit 50.
-- (from Agent C: JOINs to members for author_name)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION get_audit_trail(
  p_org_id UUID,
  p_limit INT DEFAULT 50
)
RETURNS TABLE (
  id UUID,
  org_id UUID,
  member_id UUID,
  action TEXT,
  target_type TEXT,
  target_id UUID,
  previous_state JSONB,
  new_state JSONB,
  reason TEXT,
  created_at TIMESTAMPTZ,
  author_name TEXT,
  member_role TEXT
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    ae.id,
    ae.org_id,
    ae.member_id,
    ae.action,
    ae.target_type,
    ae.target_id,
    ae.previous_state,
    ae.new_state,
    ae.reason,
    ae.created_at,
    m.author_name,
    m.role AS member_role
  FROM audit_entries ae
  JOIN members m ON m.id = ae.member_id
  WHERE ae.org_id = p_org_id
  ORDER BY ae.created_at DESC
  LIMIT p_limit;
$$;

-- ------------------------------------------------------------
-- get_lifecycle_history: returns all audit entries for a specific
-- decision, ordered chronologically. Useful for viewing the full
-- status change history of a decision.
-- (from Agent C: JOINs to members for author_name)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION get_lifecycle_history(
  p_decision_id UUID
)
RETURNS TABLE (
  id UUID,
  org_id UUID,
  member_id UUID,
  action TEXT,
  target_type TEXT,
  target_id UUID,
  previous_state JSONB,
  new_state JSONB,
  reason TEXT,
  created_at TIMESTAMPTZ,
  author_name TEXT,
  member_role TEXT
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    ae.id,
    ae.org_id,
    ae.member_id,
    ae.action,
    ae.target_type,
    ae.target_id,
    ae.previous_state,
    ae.new_state,
    ae.reason,
    ae.created_at,
    m.author_name,
    m.role AS member_role
  FROM audit_entries ae
  JOIN members m ON m.id = ae.member_id
  WHERE ae.target_id = p_decision_id
    AND ae.target_type = 'decision'
  ORDER BY ae.created_at ASC;
$$;

COMMIT;
