-- Valis MVP Schema
-- Tables: orgs, members, decisions, rate_limits
-- With indexes and RLS policies

-- Organizations
CREATE TABLE IF NOT EXISTS orgs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
  api_key TEXT UNIQUE NOT NULL,
  invite_code TEXT UNIQUE NOT NULL,
  plan TEXT NOT NULL DEFAULT 'free' CHECK (plan IN ('free', 'pro', 'enterprise')),
  decision_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_orgs_api_key ON orgs(api_key);
CREATE INDEX IF NOT EXISTS idx_orgs_invite_code ON orgs(invite_code);

-- Members
CREATE TABLE IF NOT EXISTS members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  author_name TEXT NOT NULL CHECK (char_length(author_name) BETWEEN 1 AND 50),
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, author_name)
);

-- Decisions
CREATE TABLE IF NOT EXISTS decisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('decision', 'constraint', 'pattern', 'lesson', 'pending')),
  summary TEXT CHECK (summary IS NULL OR char_length(summary) <= 100),
  detail TEXT NOT NULL CHECK (char_length(detail) >= 10),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'deprecated', 'superseded', 'proposed')),
  author TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('mcp_store', 'file_watcher', 'stop_hook', 'seed')),
  project_id TEXT,
  session_id TEXT,
  content_hash TEXT NOT NULL,
  confidence INTEGER CHECK (confidence IS NULL OR (confidence BETWEEN 1 AND 10)),
  affects TEXT[] DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_decisions_org_id ON decisions(org_id);
CREATE INDEX IF NOT EXISTS idx_decisions_org_type ON decisions(org_id, type);
CREATE UNIQUE INDEX IF NOT EXISTS idx_decisions_org_hash ON decisions(org_id, content_hash);
CREATE INDEX IF NOT EXISTS idx_decisions_session_id ON decisions(session_id);
CREATE INDEX IF NOT EXISTS idx_decisions_created_at ON decisions(created_at);

-- Rate Limits
CREATE TABLE IF NOT EXISTS rate_limits (
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  day DATE NOT NULL DEFAULT CURRENT_DATE,
  store_count INTEGER NOT NULL DEFAULT 0,
  search_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (org_id, day)
);

-- Row Level Security
ALTER TABLE decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE members ENABLE ROW LEVEL SECURITY;
ALTER TABLE rate_limits ENABLE ROW LEVEL SECURITY;

-- RLS Policies: scope all operations to current org_id
CREATE POLICY decisions_org_isolation ON decisions
  FOR ALL
  USING (org_id::text = current_setting('app.org_id', true))
  WITH CHECK (org_id::text = current_setting('app.org_id', true));

CREATE POLICY members_org_isolation ON members
  FOR ALL
  USING (org_id::text = current_setting('app.org_id', true))
  WITH CHECK (org_id::text = current_setting('app.org_id', true));

CREATE POLICY rate_limits_org_isolation ON rate_limits
  FOR ALL
  USING (org_id::text = current_setting('app.org_id', true))
  WITH CHECK (org_id::text = current_setting('app.org_id', true));

-- Search RPC function for Supabase client
CREATE OR REPLACE FUNCTION search_decisions(
  p_org_id UUID,
  p_query TEXT,
  p_type TEXT DEFAULT NULL,
  p_limit INTEGER DEFAULT 10
)
RETURNS SETOF decisions
LANGUAGE sql
STABLE
AS $$
  SELECT *
  FROM decisions
  WHERE org_id = p_org_id
    AND (p_type IS NULL OR type = p_type)
    AND (
      detail ILIKE '%' || p_query || '%'
      OR summary ILIKE '%' || p_query || '%'
    )
  ORDER BY created_at DESC
  LIMIT p_limit;
$$;

-- Dashboard stats RPC
CREATE OR REPLACE FUNCTION get_dashboard_stats(p_org_id UUID)
RETURNS JSON
LANGUAGE sql
STABLE
AS $$
  SELECT json_build_object(
    'total_decisions', (SELECT count(*) FROM decisions WHERE org_id = p_org_id),
    'by_type', (
      SELECT json_object_agg(type, cnt)
      FROM (SELECT type, count(*) as cnt FROM decisions WHERE org_id = p_org_id GROUP BY type) t
    ),
    'by_author', (
      SELECT json_object_agg(author, cnt)
      FROM (SELECT author, count(*) as cnt FROM decisions WHERE org_id = p_org_id GROUP BY author) a
    ),
    'pending_count', (SELECT count(*) FROM decisions WHERE org_id = p_org_id AND type = 'pending')
  );
$$;
