/**
 * 045 Find Gaps — engine types + the injected LLM client interface (the test seam).
 *
 * `GapLlmClient` is the single boundary the engine crosses to reach a model.
 * It is defined here (CLI package) but implemented in two places:
 *   - production: `packages/web/src/lib/gap-llm.ts` over the AI Gateway;
 *   - tests:      a canned client in `packages/cli/test/gaps/` returning
 *                 deterministic stage outputs (zero live calls).
 *
 * The interface owns the FR-028 budget contract: the pipeline counts
 * invocations and throws `model_budget_exceeded` defensively past
 * `MAX_MODEL_CALLS`. Provider/validation failures surface as `GapEngineError`
 * with a typed code the run executor maps onto `gap_runs.error`.
 */

export type Register = 'standard' | 'synthesized';

/** Decision projection the engine reasons over. Mirrors the 044 DecisionLite convention. */
export interface DecisionLite {
  id: string;
  summary: string | null;
  detail: string;
  affects: string[];
  status: string;
  updated_at: string;
}

/** One archetype component (the canonical `component` key is the cross-run dedup anchor). */
export interface ArchetypeComponent {
  component: string;
  /** 1–5 — ranking input. */
  importance: number;
  commonly_forgotten: boolean;
  /** Fork description → surfaced AS a question, never silently resolved (FR-016). */
  conditional_on?: string;
  /** Named platforms that, if in use, cover this component (seeds FR-014). */
  platform_provided_by?: string[];
}

export interface Archetype {
  domain: string;
  /** semver string. */
  version: string;
  components: ArchetypeComponent[];
}

/** Stage 1 output: open domain classification + on-demand archetype for unmapped domains. */
export interface ClassifyResult {
  /** Free-form classified domain label; `resolveArchetype` maps it to a curated file. */
  domain: string;
  /** On-demand archetype draft — used only when the domain maps to no curated file (R7). */
  derivedArchetype: Archetype;
  /** Model self-rated reliability — telemetry only, NEVER gates anything (FR-012). */
  reliability: number | null;
}

/** A component judged absent from the recorded knowledge — a question candidate. */
export interface AbsentComponent {
  component: string;
  /** 1–5. */
  importance: number;
  /** Short reason the component matters / is likely missing — feeds `whyAsking`. */
  rationale?: string;
}

/** A conditional branch (`conditional_on`) the team has not resolved — surfaced as a fork-question. */
export interface ForkComponent {
  component: string;
  /** 1–5. */
  importance: number;
  /** The branch description from `conditional_on`. */
  conditionalOn: string;
}

/** Stage 2 output: coverage reconciliation against the archetype. */
export interface CoverageResult {
  /** Components reconciled as present in the recorded knowledge — never flagged. */
  present: string[];
  /** Candidate gaps. */
  absent: AbsentComponent[];
  /** Covered by a named platform — never flagged (FR-014). */
  platformProvided: string[];
  /** Unresolved conditional branches → fork-questions (FR-016). */
  forks: ForkComponent[];
}

/** Stage 3 output: a candidate phrased as a grounded, ranked question. */
export interface ArticulatedQuestion {
  component: string;
  /** Interrogative, ask-don't-tell (FR-005). */
  question: string;
  whyAsking: string;
  /** Non-empty grounding references (FR-006). */
  groundingDecisionIds: string[];
  /** 1–5. */
  importance: number;
  /** 1–5. */
  nonObviousness: number;
}

/**
 * The injected client. Each method is one pipeline stage; the pipeline counts
 * calls against the FR-028 budget. Implementations MUST throw `GapEngineError`
 * with `llm_provider_unavailable` / `llm_output_invalid` on failure so the run
 * executor can finalize the run row faithfully.
 */
export interface GapLlmClient {
  /** Stage 1 (1 call): classify the domain + draft an archetype for unmapped domains. */
  classifyAndDerive(input: { decisions: DecisionLite[] }): Promise<ClassifyResult>;
  /** Stage 2 (1–2 calls): reconcile coverage — present / absent / platform-provided / fork. */
  reconcileCoverage(input: {
    decisions: DecisionLite[];
    archetype: Archetype;
  }): Promise<CoverageResult>;
  /** Stage 3 (1 call, ≤1 refine): phrase top candidates as grounded questions + rank. */
  articulateAndRank(input: {
    candidates: AbsentComponent[];
    decisions: DecisionLite[];
  }): Promise<ArticulatedQuestion[]>;
}

export type GapErrorCode =
  | 'llm_provider_unavailable'
  | 'llm_output_invalid'
  | 'model_budget_exceeded';

/** Typed engine failure. `code` maps 1:1 onto `gap_runs.error` (contracts/api.md). */
export class GapEngineError extends Error {
  constructor(
    public readonly code: GapErrorCode,
    message?: string,
  ) {
    super(message ?? code);
    this.name = 'GapEngineError';
  }
}
