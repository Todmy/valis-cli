-- Feature 043 — explicit system-vs-person resolution axis. Split out of 031
-- because 031 was already applied before this column was designed; never edit
-- an applied migration.
--
-- How the current resolution was reached: a person clicking (human) vs the
-- Auto-triage system applying on the consenting member's behalf (auto). WHO is
-- already on the row (`status_changed_by`); this adds the explicit
-- system-vs-person axis (Constitution X: even 'auto' traces to a member via
-- status_changed_by — there is no anonymous system). NULL while still proposed
-- or for pre-existing rows. Written by `applyForwardTransition` (default
-- 'human'; auto-apply passes 'auto'); set NULL on reverse.

ALTER TABLE decisions
  ADD COLUMN IF NOT EXISTS resolved_via text NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'decisions_resolved_via_chk'
  ) THEN
    ALTER TABLE decisions
      ADD CONSTRAINT decisions_resolved_via_chk
      CHECK (resolved_via IS NULL OR resolved_via IN ('human','auto'));
  END IF;
END $$;
