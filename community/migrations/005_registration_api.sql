-- Migration 005: Registration API rate limiting
-- Additive only — no changes to existing tables

CREATE TABLE IF NOT EXISTS registration_rate_limits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ip_address TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_registration_rate_limits_ip_time
  ON registration_rate_limits (ip_address, created_at DESC);

-- RLS: only service_role can access this table (Edge Functions run as service_role)
ALTER TABLE registration_rate_limits ENABLE ROW LEVEL SECURITY;
-- No RLS policies = only service_role can read/write (Edge Functions use service_role)
