/**
 * 045 Find Gaps — single tunable config module (FR-029).
 *
 * Every gate and threshold the engine consults lives here as a named constant.
 * Research R10 fixes the initial values; they are explicit calibration targets,
 * not deployment config (so: constants, never env vars). The pipeline consumes
 * them as a `GapsConfig` object so tests can override a single field without
 * mutating module state.
 */

/** Max questions surfaced per run (top-N by importance × non-obviousness). */
export const TOP_N_QUESTIONS = 3;

/** Hard ceiling on LLM invocations per run; pipeline throws past this (FR-028). */
export const MAX_MODEL_CALLS = 4;

/** Max articulate-stage refine loops (≤1 keeps the budget statically ≤4). */
export const MAX_REFINE_LOOPS = 1;

/** Below this many active decisions a run is refused (FR-008). */
export const MIN_DECISIONS_TO_ANALYZE = 5;

/** Above this, the most-recent subset is analyzed and `truncated` is set. */
export const MAX_DECISIONS_ANALYZED = 500;

/** Cosine floor for the absence gate: a hit ≥ this marks a component answered (FR-017). */
export const ABSENCE_GATE_SIM_FLOOR = 0.75;

/** Judge gate: a candidate below this importance is not worth a question. */
export const JUDGE_MIN_IMPORTANCE = 2;

/** Judge gate: a candidate below this non-obviousness is a generic checklist item, not a gap. */
export const JUDGE_MIN_NON_OBVIOUSNESS = 2;

/** Consistency sampling (multi-sample register agreement) — config-flagged later upgrade, default off (R6). */
export const CONSISTENCY_SAMPLING_ENABLED = false;

export interface GapsConfig {
  topNQuestions: number;
  maxModelCalls: number;
  maxRefineLoops: number;
  minDecisionsToAnalyze: number;
  maxDecisionsAnalyzed: number;
  absenceGateSimFloor: number;
  judgeMinImportance: number;
  judgeMinNonObviousness: number;
  consistencySamplingEnabled: boolean;
}

/** The shipped defaults. Pass a shallow clone with overrides in tests. */
export const DEFAULT_GAPS_CONFIG: GapsConfig = {
  topNQuestions: TOP_N_QUESTIONS,
  maxModelCalls: MAX_MODEL_CALLS,
  maxRefineLoops: MAX_REFINE_LOOPS,
  minDecisionsToAnalyze: MIN_DECISIONS_TO_ANALYZE,
  maxDecisionsAnalyzed: MAX_DECISIONS_ANALYZED,
  absenceGateSimFloor: ABSENCE_GATE_SIM_FLOOR,
  judgeMinImportance: JUDGE_MIN_IMPORTANCE,
  judgeMinNonObviousness: JUDGE_MIN_NON_OBVIOUSNESS,
  consistencySamplingEnabled: CONSISTENCY_SAMPLING_ENABLED,
};
