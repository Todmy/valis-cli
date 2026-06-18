-- Auth-compat prep, applied before the Valis migrations.
--
-- The supabase/postgres image creates the `auth` schema, the roles, and the
-- auth.uid()/auth.role()/auth.email() helpers — but NOT auth.jwt(), and not
-- auth.users (GoTrue owns that, and only creates it when the auth container
-- first boots, which is AFTER this step). The Valis migrations need both:
--   * migration 009 adds members.auth_user_id REFERENCES auth.users(id)
--   * several RLS policies call auth.jwt()->>'...'
-- So we provide a minimal auth.users (GoTrue's own CREATE TABLE IF NOT EXISTS
-- adopts it) and the canonical auth.jwt() helper. All statements are
-- idempotent.

CREATE SCHEMA IF NOT EXISTS auth;

-- auth.users — FK target for migration 009. GoTrue extends this table
-- idempotently on first boot.
CREATE TABLE IF NOT EXISTS auth.users (
  id UUID NOT NULL PRIMARY KEY DEFAULT gen_random_uuid()
);

-- auth.jwt() — full decoded JWT claims. PostgREST exposes them via the
-- `request.jwt.claims` GUC; older callers used `request.jwt.claim`.
-- Mirrors Supabase's canonical definition.
--
-- GoTrue ships an identical migration (20220531120530_add_auth_jwt_function)
-- that does CREATE OR REPLACE on this function as supabase_auth_admin. So we
-- create it owned by supabase_auth_admin — otherwise GoTrue's migration fails
-- with "must be owner of function jwt". Same reasoning for auth.users above.
CREATE OR REPLACE FUNCTION auth.jwt() RETURNS jsonb
  LANGUAGE sql STABLE
AS $$
  SELECT COALESCE(
    NULLIF(current_setting('request.jwt.claim', true), ''),
    NULLIF(current_setting('request.jwt.claims', true), '')
  )::jsonb
$$;

ALTER FUNCTION auth.jwt() OWNER TO supabase_auth_admin;
ALTER TABLE auth.users OWNER TO supabase_auth_admin;
