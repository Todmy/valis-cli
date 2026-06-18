-- 019: Phase 12 supplements to projects — FR-040 (recurrence_threshold) + FR-041 (template_version).
--
-- Per spec 019 supplements (added 2026-04-26):
--   - FR-040: recurrence_threshold smallint NULL (range 2..20; NULL = system default 3)
--   - FR-041: template_version text NULL (semver snapshot at seed time)
--   - constitution_templates is NOT a DB table at v1 (templates live in code at
--     packages/cli/src/templates/*.json) — no DDL needed for the template_version
--     side; semver lives in the JSON's `version` field and is snapshotted onto
--     projects.template_version when seeding.

ALTER TABLE projects
  ADD COLUMN template_version text NULL,
  ADD COLUMN recurrence_threshold smallint NULL
    CHECK (recurrence_threshold IS NULL OR (recurrence_threshold BETWEEN 2 AND 20));

COMMENT ON COLUMN projects.template_version IS
  '019/FR-041 — semver string snapshotted from constitution_templates at seed time. Format: ''0.1'', ''1.0'', etc. NULL on projects created blank or before this migration. Decouples seeded projects from later template-version bumps (preserves FR-037).';
COMMENT ON COLUMN projects.recurrence_threshold IS
  '019/FR-040 — per-project override for the post-dismissal recurrence threshold (default 3). Range 2..20. NULL means use the system default. Set via PATCH /api/projects/[id]/settings (project_admin only).';
