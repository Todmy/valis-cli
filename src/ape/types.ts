/**
 * 285 APE harness — shared type surface.
 *
 * All interfaces consumed across the `ape/` module live here. This is a pure
 * type file: no runtime code, no imports. Bodies that implement these contracts
 * live in the per-task modules (corpus, trial, eval, optimizer, agents).
 *
 * Mirrors `docs/krukit/285-ape-harness/plan.md` Task 1.
 */

export type Axis = 'consult' | 'inject';
export type Stratum = 'store' | 'near_boundary' | 'normal';
export type LabelSource = 'llm_proposed' | 'human_confirmed';

export interface ApeCorpusItem {
  id: string;
  prompt: string;
  should_consult: boolean;
  should_inject: boolean;
  stratum: Stratum;
  label_source: LabelSource;
  needs_human_confirm: boolean;
  source_session?: string;
}

/**
 * RT9: canonical multi-step eval unit (re-plan v2). Promoted here from
 * `corpus/schema.ts` so every consumer shares one source of truth. Context turns
 * `[0..n-2]` are conversational history; the consult/inject decision is measured
 * at the LAST turn.
 */
export interface ApeScenario {
  id: string;
  /** Conversation turns; the consult/inject decision is measured at the last. */
  turns: string[];
  should_consult: boolean;
  should_inject: boolean;
  stratum: Stratum;
  label_source: LabelSource;
  needs_human_confirm: boolean;
  source_session?: string;
  /** RT17 (F8): per-scenario relevant hits to inject in the push trial. */
  injected_hits?: InjectedHit[];
}

/**
 * RT17 (F8): a relevant search hit to inject for a scenario's push trial.
 * Structurally mirrors `hooks/inject-block.ts::SearchResultRow` (kept local to
 * preserve this file's no-imports rule); `push.ts` maps it to that type. When a
 * scenario carries `injected_hits`, the push trial injects THESE (relevant to the
 * prompt) instead of a fixed off-topic fixture — so `injectActionRate` measures
 * acting on RELEVANT context, not blind compliance.
 */
export interface InjectedHit {
  id: string;
  summary: string;
  type: string;
  status?: string;
  score: number;
  affects?: string[];
}

/** Length-bucket → target count, e.g. `{ 1: 3, 2: 2, 3: 1 }`. */
export type ScenarioMix = Record<number, number>;

/**
 * RT9: an available tool offered to a worker subagent — name + the candidate
 * description under optimization. Promoted from `trial/pull.ts`.
 */
export interface WorkerTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/**
 * RT9: the deterministic, LLM-free brief the in-session orchestration hands to a
 * worker subagent. Promoted from `trial/pull.ts`. `context` is the joined prior
 * turns (empty for a 1-turn scenario); `decisionTurn` is the last turn (the
 * actual ask); `tools` are the candidate-described valis tools; `schema` is the
 * structured-output contract the worker must satisfy.
 */
export interface WorkerBrief {
  context: string;
  decisionTurn: string;
  tools: WorkerTool[];
  schema: string;
  /**
   * RT20 (F10): present on PUSH (inject) briefs only. The push trial is two-stage
   * — the worker produces a free-text ANSWER, then an Opus judge scores how well
   * that answer FOLLOWS the injected decision (inject-action is a quality
   * judgement, not a tool-call). The session builds the judge prompt from
   * `judge.system` + `judge.task` + the worker's answer, spawns the judge, and
   * records the judge's numeric score (see `push.ts::scorePushAnswer`).
   */
  judge?: { system: string; task: string };
}

export interface MechanicalLabels {
  consulted: boolean;
  acted: boolean;
}

/**
 * RT9: call/token budget caps (re-plan v2 — no AI Gateway, no external key, no
 * USD). Promoted from `optimizer/spend.ts`.
 */
export interface BudgetCaps {
  maxCalls: number;
  maxTokensEst: number;
}

/** RT9: the runtime budget tracker contract. Promoted from `optimizer/spend.ts`. */
export interface Budget {
  addCall(tokensEst: number): void;
  calls(): number;
  remaining(): { calls: number; tokensEst: number };
  assertWithin(): void;
}

export interface TrialResult {
  itemId: string;
  variantId: string;
  mechanical: MechanicalLabels;
  /** Judge scores per axis — bare numbers in [0,1] (RT6; no axis wrapper, no USD). */
  judge?: number[];
  rawOutput: string;
}

export interface ParsedSession {
  sessionId: string;
  version?: string;
  prompts: { text: string; consulted: boolean; injected: boolean }[];
}

export interface PatchDescriptor {
  surface: 'pull_tool_description' | 'push_injection_template';
  file: string;
  anchor: string; // unique string to locate the edit site
}

export interface AgentAdapter {
  parseLog(jsonl: string): ParsedSession;
  detectToolCall(workerResponse: unknown): { tool: string | null; fired: boolean };
  deployTarget(surface: PatchDescriptor['surface']): PatchDescriptor;
}

export interface PromptVariant {
  id: string;
  surface: PatchDescriptor['surface'];
  text: string;
}

export interface Optimizer {
  propose(current: PromptVariant, feedback: EvalSummary): Promise<PromptVariant[]>;
}

export interface EvalSummary {
  consultPrecision: number;
  consultRecall: number;
  injectActionRate: number;
  nearBoundaryFpRate: number;
  failingExamples: { prompt: string; expected: string; got: string }[];
}
