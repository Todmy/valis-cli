-- Migration 003: Search Intelligence, Data Quality & Growth
-- Additive only — no columns removed, no types changed.
-- Safe to run on databases that already have migrations 001 + 002.
--
-- Changes:
--   ALTER decisions:     add pinned, enriched_by; expand source CHECK
--   ALTER orgs:          expand plan CHECK to include 'team','business'; migrate 'pro' -> 'team'
--   New table:           subscriptions
--   New table:           usage_overages
--   New table:           enrichment_usage
--   ALTER audit_entries: expand action CHECK for new audit actions
--   New RLS policies:    subscriptions, usage_overages, enrichment_usage
--   New RPC functions:   increment_enrichment_usage, increment_usage_overage
--   New indexes:         decisions.pinned partial, subscriptions uniques, overages composite

BEGIN;

-- ============================================================
-- 1. ALTER decisions — new columns
-- ============================================================

-- pinned: exempt from confidence decay in search ranking
ALTER TABLE decisions
  ADD COLUMN IF NOT EXISTS pinned BOOLEAN NOT NULL DEFAULT false;

-- enriched_by: tracks how a pending decision was classified
ALTER TABLE decisions
  ADD COLUMN IF NOT EXISTS enriched_by TEXT;

-- CHECK constraint on enriched_by
ALTER TABLE decisions
  DROP CONSTRAINT IF EXISTS decisions_enriched_by_check;
ALTER TABLE decisions
  ADD CONSTRAINT decisions_enriched_by_check
  CHECK (enriched_by IS NULL OR enriched_by IN ('llm', 'manual'));

-- Partial index on pinned decisions for fast reranking lookup
CREATE INDEX IF NOT EXISTS idx_decisions_pinned
  ON decisions(id)
  WHERE pinned = true;

-- ============================================================
-- 2. Expand decisions.source CHECK to include 'synthesis'
-- ============================================================

ALTER TABLE decisions
  DROP CONSTRAINT IF EXISTS decisions_source_check;
ALTER TABLE decisions
  ADD CONSTRAINT decisions_source_check
  CHECK (source IN ('mcp_store', 'file_watcher', 'stop_hook', 'seed', 'synthesis'));

-- ============================================================
-- 3. ALTER orgs — expand plan CHECK, migrate 'pro' -> 'team'
-- ============================================================

ALTER TABLE orgs DROP CONSTRAINT IF EXISTS orgs_plan_check;
ALTER TABLE orgs ADD CONSTRAINT orgs_plan_check
  CHECK (plan IN ('free', 'team', 'business', 'enterprise'));

-- Migrate existing 'pro' rows to 'team'
UPDATE orgs SET plan = 'team' WHERE plan = 'pro';

-- ============================================================
-- 4. Expand audit_entries action CHECK for new actions
-- ============================================================

ALTER TABLE audit_entries
  DROP CONSTRAINT IF EXISTS audit_entries_action_check;
ALTER TABLE audit_entries
  ADD CONSTRAINT audit_entries_action_check CHECK (action IN (
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
    'contradiction_resolved',
    'decision_pinned',
    'decision_unpinned',
    'decision_enriched',
    'decision_auto_deduped',
    'pattern_synthesized'
  ));

-- ============================================================
-- 5. New table: subscriptions
-- ============================================================

CREATE TABLE IF NOT EXISTS subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  plan TEXT NOT NULL DEFAULT 'free'
    CHECK (plan IN ('free', 'team', 'business', 'enterprise')),
  billing_cycle TEXT NOT NULL DEFAULT 'monthly'
    CHECK (billing_cycle IN ('monthly', 'annual')),
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'past_due', 'cancelled', 'trialing')),
  current_period_start TIMESTAMPTZ,
  current_period_end TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One subscription per org
CREATE UNIQUE INDEX IF NOT EXISTS idx_subscriptions_org_id
  ON subscriptions(org_id);

-- Unique Stripe customer ID (partial — only non-null)
CREATE UNIQUE INDEX IF NOT EXISTS idx_subscriptions_stripe_customer
  ON subscriptions(stripe_customer_id)
  WHERE stripe_customer_id IS NOT NULL;

-- Unique Stripe subscription ID (partial — only non-null)
CREATE UNIQUE INDEX IF NOT EXISTS idx_subscriptions_stripe_sub
  ON subscriptions(stripe_subscription_id)
  WHERE stripe_subscription_id IS NOT NULL;

-- ============================================================
-- 6. New table: usage_overages
-- ============================================================

CREATE TABLE IF NOT EXISTS usage_overages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  period_start TIMESTAMPTZ NOT NULL,
  period_end TIMESTAMPTZ NOT NULL,
  extra_decisions INTEGER NOT NULL DEFAULT 0
    CHECK (extra_decisions >= 0),
  extra_searches INTEGER NOT NULL DEFAULT 0
    CHECK (extra_searches >= 0),
  amount_cents INTEGER NOT NULL DEFAULT 0
    CHECK (amount_cents >= 0),
  billed_at TIMESTAMPTZ,

  CONSTRAINT usage_overages_period_order CHECK (period_start < period_end),
  CONSTRAINT usage_overages_org_period_unique UNIQUE (org_id, period_start)
);

-- Composite index for current period lookup
CREATE INDEX IF NOT EXISTS idx_usage_overages_org_period
  ON usage_overages(org_id, period_end DESC);

-- ============================================================
-- 7. New table: enrichment_usage
-- ============================================================

CREATE TABLE IF NOT EXISTS enrichment_usage (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  date DATE NOT NULL,
  provider TEXT NOT NULL,
  decisions_enriched INTEGER NOT NULL DEFAULT 0,
  tokens_used INTEGER NOT NULL DEFAULT 0,
  cost_cents INTEGER NOT NULL DEFAULT 0,

  CONSTRAINT enrichment_usage_org_date_provider_unique
    UNIQUE (org_id, date, provider)
);

-- ============================================================
-- 8. Row Level Security — new tables
-- ============================================================

ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage_overages ENABLE ROW LEVEL SECURITY;
ALTER TABLE enrichment_usage ENABLE ROW LEVEL SECURITY;

-- ------------------------------------------------------------
-- 8a. subscriptions policies
-- ------------------------------------------------------------

-- Read: org members can view their own subscription
CREATE POLICY subscriptions_read_jwt ON subscriptions
  FOR SELECT
  USING (org_id::text = effective_org_id());

-- Write: service_role only (Edge Functions handle mutations)
-- No INSERT/UPDATE/DELETE policy for authenticated role.

-- ------------------------------------------------------------
-- 8b. usage_overages policies
-- ------------------------------------------------------------

-- Read: org members can view overages
CREATE POLICY overages_read_jwt ON usage_overages
  FOR SELECT
  USING (org_id::text = effective_org_id());

-- Write: service_role only

-- ------------------------------------------------------------
-- 8c. enrichment_usage policies
-- ------------------------------------------------------------

-- Read: org members can view enrichment usage
CREATE POLICY enrichment_read_jwt ON enrichment_usage
  FOR SELECT
  USING (org_id::text = effective_org_id());

-- Write: service_role only

-- ============================================================
-- 9. RPC Functions
-- ============================================================

-- ------------------------------------------------------------
-- increment_enrichment_usage: upserts a row for the current day
-- and provider, incrementing counters atomically.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION increment_enrichment_usage(
  p_org_id UUID,
  p_provider TEXT,
  p_decisions INTEGER DEFAULT 1,
  p_tokens INTEGER DEFAULT 0,
  p_cost_cents INTEGER DEFAULT 0
)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO enrichment_usage (org_id, date, provider, decisions_enriched, tokens_used, cost_cents)
  VALUES (p_org_id, CURRENT_DATE, p_provider, p_decisions, p_tokens, p_cost_cents)
  ON CONFLICT ON CONSTRAINT enrichment_usage_org_date_provider_unique
  DO UPDATE SET
    decisions_enriched = enrichment_usage.decisions_enriched + EXCLUDED.decisions_enriched,
    tokens_used = enrichment_usage.tokens_used + EXCLUDED.tokens_used,
    cost_cents = enrichment_usage.cost_cents + EXCLUDED.cost_cents;
END;
$$;

-- ------------------------------------------------------------
-- increment_usage_overage: upserts an overage record for the
-- given billing period, incrementing counters and recalculating
-- amount_cents based on overage rates.
-- Rates: $0.005/decision (0.5 cents), $0.002/search (0.2 cents)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION increment_usage_overage(
  p_org_id UUID,
  p_period_start TIMESTAMPTZ,
  p_period_end TIMESTAMPTZ,
  p_extra_decisions INTEGER DEFAULT 0,
  p_extra_searches INTEGER DEFAULT 0
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_new_decisions INTEGER;
  v_new_searches INTEGER;
BEGIN
  INSERT INTO usage_overages (org_id, period_start, period_end, extra_decisions, extra_searches, amount_cents)
  VALUES (
    p_org_id,
    p_period_start,
    p_period_end,
    p_extra_decisions,
    p_extra_searches,
    FLOOR(p_extra_decisions * 0.5 + p_extra_searches * 0.2)::INTEGER
  )
  ON CONFLICT ON CONSTRAINT usage_overages_org_period_unique
  DO UPDATE SET
    extra_decisions = usage_overages.extra_decisions + EXCLUDED.extra_decisions,
    extra_searches = usage_overages.extra_searches + EXCLUDED.extra_searches,
    amount_cents = FLOOR(
      (usage_overages.extra_decisions + EXCLUDED.extra_decisions) * 0.5 +
      (usage_overages.extra_searches + EXCLUDED.extra_searches) * 0.2
    )::INTEGER;
END;
$$;

COMMIT;
