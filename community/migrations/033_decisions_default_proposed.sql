-- #255 — make 'proposed' the STRUCTURAL default for new decisions.
--
-- The "active requires explicit review" invariant (FR-018) was enforced only in
-- application code (normalizeStoreStatus, packages/cli/src/types.ts) — the DB
-- column still defaulted to 'active' (001_init.sql), a latent trap: any future
-- insert path that omits status would silently create an active decision that
-- skips the proposed/triage review queue.
--
-- Verified safe: every current writer sets status EXPLICITLY (valis_store via
-- normalizeStoreStatus, valis index via typeFromPrefix, project seeds via a
-- literal 'active', /api/seed via its own resolver). Nothing relies on the
-- column default today, so flipping it changes no current behavior — it only
-- hardens the invariant at the DB layer for future code.
--
-- The deliberate active-creating paths (constitution/template seed; valis index
-- type-prefixed imports) are unaffected because they pass status explicitly.
-- Whether THOSE should route through 'proposed' is a separate product decision
-- tracked in #255 — this migration does not change them.

ALTER TABLE decisions ALTER COLUMN status SET DEFAULT 'proposed';
