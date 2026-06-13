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

export interface MechanicalLabels {
  consulted: boolean;
  acted: boolean;
}

export interface JudgeScore {
  axis: Axis;
  score: number;
} // minimal numeric output

export interface TrialResult {
  itemId: string;
  variantId: string;
  mechanical: MechanicalLabels;
  judge?: JudgeScore[];
  rawOutput: string;
  costUsd: number;
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
