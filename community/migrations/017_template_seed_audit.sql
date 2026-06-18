-- 017: Add `projects.template_source` column for US6 (Constitution Templates).
--
-- Per spec 019 FR-033..FR-038 + data-model.md §8. Records which curated
-- starter template seeded a project (e.g. 'ts-saas@v0.1', 'fintech@v0.1',
-- 'ai-agent@v0.1'). Templates themselves live in code at
-- packages/cli/src/templates/*.json — there is intentionally NO templates
-- table; the column is a FK-less backreference for analytics + dedupe.
--
-- NULL value = project was created blank (no template).
-- Non-NULL format: '<template_id>@<version>' so a future template revision
-- can be tracked. Migration 019 (Phase 12) adds a structured
-- `projects.template_version` column for the same provenance need.

ALTER TABLE projects
  ADD COLUMN template_source text;

COMMENT ON COLUMN projects.template_source IS
  '019/US6 — which constitution template seeded this project. Format: ''<template_id>@<version>'' (e.g. ''ts-saas@v0.1''). NULL when the project was created blank. No FK — templates are static JSON assets in packages/cli/src/templates/, not a DB table.';
