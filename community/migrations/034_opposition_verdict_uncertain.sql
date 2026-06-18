-- 044-opposition-gate: admit the 'uncertain' opposition verdict.
--
-- Background
--   Feature 044 turns contradiction detection into an opposition gate: a pair
--   is surfaced only when an opposition verdict says it is a conflict. When the
--   classifier is unavailable / low-confidence / errors, the gate ABSTAINS —
--   it emits 'uncertain' and surfaces the pair low-confidence for human review,
--   instead of forcing a binary flag/suppress (Constitution IV: no LLM
--   dependency for core ops). See specs/044-opposition-gate/.
--
-- Schema change (ADDITIVE only — Constitution: backward-compatible migrations)
--   Widen the contradictions.verdict_classification CHECK (set in migration 030)
--   to admit the fourth value 'uncertain'. No new columns, no data migration —
--   existing rows are NULL or one of the original three values, all still valid.
--
-- Reversibility
--   Re-narrow the CHECK to the original three values. No data loss.
--
-- See specs/044-opposition-gate/{spec.md, data-model.md}.

ALTER TABLE contradictions
  DROP CONSTRAINT IF EXISTS contradictions_verdict_classification_check;

ALTER TABLE contradictions
  ADD CONSTRAINT contradictions_verdict_classification_check
  CHECK (verdict_classification IS NULL
         OR verdict_classification IN
            ('replacement', 'genuine_conflict', 'compatible', 'uncertain'));

COMMENT ON COLUMN contradictions.verdict_classification IS
  '042/044: opposition verdict — replacement|genuine_conflict|compatible|uncertain. '
  'uncertain = calibrated abstention (classifier unavailable/low-confidence). Advisory; never auto-applies.';
