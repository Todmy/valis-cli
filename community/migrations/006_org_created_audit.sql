-- Migration 006: Add 'org_created' to audit_entries action CHECK constraint
-- The register route inserts audit entries with action = 'org_created' but
-- the CHECK constraint from migration 004 does not include it.

ALTER TABLE audit_entries DROP CONSTRAINT IF EXISTS audit_entries_action_check;
ALTER TABLE audit_entries ADD CONSTRAINT audit_entries_action_check CHECK (
  action IN (
    'store', 'deprecate', 'promote', 'supersede', 'pin', 'unpin',
    'key_rotation', 'member_join', 'member_revoke', 'status_change',
    'org_created'
  )
);
