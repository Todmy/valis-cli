-- 036: Allow the same person to belong to multiple organizations.
-- Email is an identity attribute, not an organization-wide key.

ALTER TABLE members DROP CONSTRAINT IF EXISTS members_email_key;

CREATE INDEX IF NOT EXISTS idx_members_email ON members (email);
