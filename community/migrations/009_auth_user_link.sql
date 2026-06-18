-- 009: Link members to Supabase Auth users
-- Adds auth_user_id for direct RLS via auth.uid()

-- Add auth_user_id column
ALTER TABLE members ADD COLUMN IF NOT EXISTS auth_user_id UUID UNIQUE REFERENCES auth.users(id);

-- Create index for fast lookup
CREATE INDEX IF NOT EXISTS idx_members_auth_user_id ON members (auth_user_id);

-- Helper function: get org_id for the current auth user
-- SECURITY DEFINER bypasses RLS to avoid recursion (members RLS calls effective_org_id)
CREATE OR REPLACE FUNCTION public.auth_user_org_id()
RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  SELECT m.org_id::text
  FROM members m
  WHERE m.auth_user_id = auth.uid()
    AND m.revoked_at IS NULL
  LIMIT 1;
$$;

-- Helper function: get member_id for the current auth user
-- SECURITY DEFINER bypasses RLS to avoid recursion
CREATE OR REPLACE FUNCTION public.auth_user_member_id()
RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  SELECT m.id::text
  FROM members m
  WHERE m.auth_user_id = auth.uid()
    AND m.revoked_at IS NULL
  LIMIT 1;
$$;

-- Update effective_org_id to also check auth_user_id
CREATE OR REPLACE FUNCTION public.effective_org_id()
RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(
    NULLIF(current_setting('app.org_id', true), ''),
    (SELECT auth.jwt()->>'org_id'),
    auth_user_org_id()
  );
$$;

-- Update RLS policies for project_members to also allow auth.uid() lookup
DROP POLICY IF EXISTS "project_members_read" ON project_members;
CREATE POLICY "project_members_read" ON project_members
  FOR SELECT USING (
    (member_id::text = (SELECT auth.jwt()->>'sub'))
    OR (member_id::text = auth_user_member_id())
    OR (EXISTS (
      SELECT 1 FROM members m
      WHERE (m.id::text = (SELECT auth.jwt()->>'sub') OR m.auth_user_id = auth.uid())
        AND m.role = 'admin'
        AND m.org_id = (SELECT p.org_id FROM projects p WHERE p.id = project_members.project_id)
    ))
  );
