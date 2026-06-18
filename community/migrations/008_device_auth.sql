-- 008: Device Authorization Login
-- Adds email to members + device_codes table for RFC 8628 device auth flow

-- Add email column to members for linking to Supabase Auth
ALTER TABLE members ADD COLUMN IF NOT EXISTS email TEXT UNIQUE;

-- Device codes for CLI → browser authorization flow
CREATE TABLE IF NOT EXISTS device_codes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_code TEXT NOT NULL UNIQUE,
  device_code TEXT NOT NULL UNIQUE,
  member_id UUID REFERENCES members(id),
  member_api_key TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'expired', 'denied')),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ip_address TEXT
);

CREATE INDEX IF NOT EXISTS idx_device_codes_ip_created
  ON device_codes (ip_address, created_at);

-- members.email UNIQUE constraint creates implicit btree index.
-- Explicit index not needed — UNIQUE = index.
