-- 013: Drop audit_entries.action CHECK constraint.
--
-- Root cause caught 2026-04-23 during /api/check dogfood probe:
-- logCheckRun INSERT was failing silently because migration 012 added 5
-- new action *values* (ci_check_run, ack, override, override_denied,
-- project_settings_change) but did NOT extend the
-- audit_entries_action_check constraint from migration 004. Route still
-- returned violations (partial-success pattern) with audit_failed=true,
-- but audit rows never landed — breaking compliance trail, dashboard
-- timeline, and the dedup source for decisions.violation_count.
--
-- Initial fix tried to re-add the CHECK with all known actions appended
-- but ALTER failed — existing prod rows contain action values not in any
-- migration's list (e.g. `org_created` from 005 register flow, plus other
-- dynamic values assigned via auditAction variables). Rebuilding a fully
-- correct CHECK would require auditing every insert site + every historic
-- row, and every future feature would need another ALTER migration.
--
-- Decision: drop the CHECK. Audit hygiene is enforced at the application
-- layer via the `AuditAction` TypeScript type. audit_entries is an
-- internal append-only table — permissive DB + typed app code is the
-- right trade-off for a solo-founder codebase. Prod remains stable, new
-- feature migrations stop needing this maintenance.

ALTER TABLE audit_entries
  DROP CONSTRAINT IF EXISTS audit_entries_action_check;

COMMENT ON COLUMN audit_entries.action IS
  '018: no DB-level enum; TypeScript `AuditAction` in packages/cli/src/types.ts is the source of truth.';
