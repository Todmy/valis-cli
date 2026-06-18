-- 010: OAuth 2.1 tables for MCP connector
-- Adds oauth_clients (DCR), oauth_codes (auth codes), oauth_refresh_tokens (rotation)

-- Registered OAuth clients (via Dynamic Client Registration)
CREATE TABLE oauth_clients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id TEXT UNIQUE NOT NULL,
  client_secret TEXT,
  client_name TEXT,
  redirect_uris TEXT[] NOT NULL,
  grant_types TEXT[] NOT NULL DEFAULT '{authorization_code}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Short-lived authorization codes (10 min TTL, one-time use)
CREATE TABLE oauth_codes (
  code TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  project_id UUID,
  expires_at TIMESTAMPTZ NOT NULL,
  used BOOLEAN NOT NULL DEFAULT false
);

CREATE INDEX idx_oauth_codes_expires_at ON oauth_codes (expires_at);

-- Refresh tokens with rotation support (30-day TTL)
CREATE TABLE oauth_refresh_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash TEXT UNIQUE NOT NULL,
  client_id TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  project_id UUID,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_oauth_refresh_tokens_user ON oauth_refresh_tokens (user_id, revoked_at);
