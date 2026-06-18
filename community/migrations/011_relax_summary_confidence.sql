-- 014-ai-gateway-llm: align DB constraints with LLM output shape.
--
-- summary: 100 → 200 chars (single sentence can exceed 100 for complex decisions)
-- confidence: INTEGER 1-10 → REAL 0.0-1.0 (LLM returns float, route.ts was scaling;
--             storing native float avoids lossy conversion and matches the Zod schema)

ALTER TABLE decisions DROP CONSTRAINT IF EXISTS decisions_summary_check;
ALTER TABLE decisions ADD CONSTRAINT decisions_summary_check
  CHECK (summary IS NULL OR char_length(summary) <= 200);

-- Step 1: drop old constraint, change column type
ALTER TABLE decisions DROP CONSTRAINT IF EXISTS decisions_confidence_check;
ALTER TABLE decisions ALTER COLUMN confidence TYPE REAL USING confidence::real;

-- Step 2: backfill BEFORE adding new constraint (existing rows have 1-10 scale)
UPDATE decisions SET confidence = confidence / 10.0
  WHERE confidence IS NOT NULL AND confidence > 1;

-- Step 3: now safe to add 0.0-1.0 constraint
ALTER TABLE decisions ADD CONSTRAINT decisions_confidence_check
  CHECK (confidence IS NULL OR (confidence >= 0.0 AND confidence <= 1.0));
