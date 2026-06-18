-- 014: Relax audit_entries for system-level events (018 ci_check_run and
-- successors).
--
-- Root cause caught 2026-04-23 during /api/check dogfood probe: even after
-- migration 013 dropped audit_entries_action_check, INSERTs still failed
-- because audit_entries (migration 002) requires NOT NULL target_type +
-- target_id with target_type CHECK IN ('decision','member','org'). These
-- constraints were designed for decision-centric events where each row
-- has exactly one target. ci_check_run is a system event that may affect
-- 0..N decisions — no natural 1-to-1 target.
--
-- Fix:
--   1. Drop target_type CHECK (same pattern as 013 drop of action CHECK).
--   2. Make target_type + target_id NULLable so system events (ci_check_run,
--      future rate_limit, health_probe, etc.) can omit them. Decision-
--      centric events continue to populate both.
--   3. Make member_id NULLable for automated system events that lack a
--      human actor (e.g. scheduled maintenance). Existing ci_check_run
--      attribution via token.issued_by stays populated.
--
-- Permissive DB + typed app layer (AuditAction + target-type literals in
-- packages/cli/src/types.ts) is the source-of-truth discipline going
-- forward. Matches 013 decision.

-- Drop target_type enum
ALTER TABLE audit_entries
  DROP CONSTRAINT IF EXISTS audit_entries_target_type_check;

-- Relax NOT NULL on target_type / target_id / member_id
ALTER TABLE audit_entries
  ALTER COLUMN target_type DROP NOT NULL;

ALTER TABLE audit_entries
  ALTER COLUMN target_id DROP NOT NULL;

ALTER TABLE audit_entries
  ALTER COLUMN member_id DROP NOT NULL;

COMMENT ON COLUMN audit_entries.target_type IS
  'NULL for system-level events (ci_check_run, etc.). TypeScript taxonomy in packages/cli/src/types.ts.';
COMMENT ON COLUMN audit_entries.target_id IS
  'NULL for system-level events. For decision-centric events: FK-less UUID (validated at app layer).';
COMMENT ON COLUMN audit_entries.member_id IS
  'NULL for fully automated events. Populated with actor (token issuer or OAuth user) for human-triggered events.';
