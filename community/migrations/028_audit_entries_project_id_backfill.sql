-- 028: Backfill audit_entries.project_id from the joined decision row.
--
-- Pre-`d28adb6` the project-overview "Recent activity" widget queried
-- audit_entries without a project filter, so the long-standing gap in the
-- audit-write path (buildAuditPayload never set project_id) was invisible.
-- The refactor to per-project scoping turned every historical row into a
-- ghost — `.eq('project_id', projectId)` filters them all out, and the
-- widget renders "No recent activity" even when the project is alive.
--
-- Forward-fixing buildAuditPayload + its five call sites stops the bleed.
-- This migration reattaches the existing rows so users see history again.
--
-- Scope: rows where `target_type = 'decision'` and `target_id` joins back
-- to a live `decisions` row. Other rows (`member_joined`, org-scoped
-- events) intentionally remain NULL — they're not project-scoped.
--
-- Idempotent: only touches rows where project_id IS NULL today. Safe to
-- re-run.

-- Both columns are UUID (audit_entries.target_id per migration 002 + 014,
-- decisions.id per migration 001). Equality is direct — no cast required.
UPDATE audit_entries ae
SET project_id = d.project_id
FROM decisions d
WHERE ae.project_id IS NULL
  AND ae.target_type = 'decision'
  AND ae.target_id = d.id
  AND d.project_id IS NOT NULL;

-- Contradictions audit rows can also point at a decision via target_id.
-- The query above already covers that case via `target_type = 'decision'`.
