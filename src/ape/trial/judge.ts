/**
 * 285/RT6: cascade judge — brief-builder + score-parser.
 *
 * The cascade splits scoring into two tiers: MECHANICAL labels (consulted /
 * acted) are free — they come from `parsePull/PushDecision` in the trial and
 * are NEVER judged here. Only the QUALITY axes that need a model go to the judge
 * subagent.
 *
 * Per the 2026-06-14 pivot (design.md §3), the LLM call is NOT made here. The
 * judge subagent is spawned by the in-session orchestration; TS keeps the two
 * PURE halves —
 *  - `buildJudgeBrief(scenario, trial, axis)` assembles a STABLE cache-prefixed
 *    rubric (`JUDGE_SYSTEM` — byte-identical across every call so the subagent
 *    prompt prefix caches) plus the minimal per-trial USER delta (axis, task,
 *    output) and the minimal-output instruction;
 *  - `parseJudgeScore(raw)` interprets the judge's returned reply → a bare
 *    number in [0,1], failing loud (021 pattern) on verbose / out-of-range
 *    output — never silently coercing a bad reply to a default score.
 *
 * NOTE: the brief carries `system`/`user`/`maxTokens`/`temperature` so the
 * orchestration can hand it verbatim to a judge subagent.
 */

import type { Axis, TrialResult } from '../types.js';
import type { ApeScenario } from '../corpus/schema.js';

/** Cap output hard — a single token reply ("0.15") is all the judge may emit. */
const JUDGE_MAX_TOKENS = 8;

/**
 * STABLE system prefix — rubric + few-shot. MUST be byte-identical across every
 * call (including across axes) so the subagent prompt prefix caches. The axis
 * and the trial output go in the per-call USER turn, never here.
 */
export const JUDGE_SYSTEM = [
  'You are a strict evaluator scoring how well a coding agent handled team-knowledge context.',
  '',
  'You score ONE quality axis on a continuous scale from 0.0 to 1.0:',
  '- consult: did the agent appropriately CONSULT the team knowledge base when team',
  '  decisions could change its action? 1.0 = consulted exactly when warranted; 0.0 = ignored a',
  '  clear need to consult, or consulted gratuitously when no team decision was relevant.',
  '- inject: given injected team context, did the agent ACT on it? 1.0 = obeyed the injected',
  '  imperative and grounded its action in the context; 0.0 = ignored the injected context entirely.',
  '',
  'A prompt warrants consult/inject when team decisions could change the action (e.g. executing a',
  'PRD, picking an approach where a prior decision exists). Translation, chit-chat, and pure',
  'restating do NOT warrant it — scoring high there is a false positive.',
  '',
  'Examples:',
  'AXIS consult / TASK warrants consult / OUTPUT searched the decision history -> 0.95',
  'AXIS consult / TASK pure translation / OUTPUT searched the decision history -> 0.10',
  'AXIS inject / context injected / OUTPUT grounded its plan in the injected decision -> 0.90',
  'AXIS inject / context injected / OUTPUT ignored it and answered generically -> 0.05',
  '',
  'Reply with ONLY a single number between 0.0 and 1.0. No words, no explanation, no units.',
].join('\n');

/**
 * The deterministic, LLM-free brief the orchestration hands to a judge subagent.
 * `system` is the stable rubric prefix; `user` is the minimal per-trial delta.
 */
export interface JudgeBrief {
  system: string;
  user: string;
  maxTokens: number;
  temperature: number;
}

/**
 * Build the judge brief from a scenario + its trial result + the axis to score.
 *
 * The decision turn (last turn of the scenario) is the TASK the agent faced; the
 * trial's `rawOutput` is what the agent produced. Both go in the minimal USER
 * delta so the stable `JUDGE_SYSTEM` prefix caches across every call.
 */
export function buildJudgeBrief(
  scenario: ApeScenario,
  trial: TrialResult,
  axis: Axis,
): JudgeBrief {
  const task = scenario.turns[scenario.turns.length - 1];
  const user = [
    `AXIS ${axis}`,
    `TASK ${task}`,
    `OUTPUT ${trial.rawOutput}`,
    'SCORE:',
  ].join('\n');

  return {
    system: JUDGE_SYSTEM,
    user,
    maxTokens: JUDGE_MAX_TOKENS,
    temperature: 0,
  };
}

/**
 * Parse a bare numeric reply in [0,1]; fail-loud (021 pattern) on anything else.
 *
 * Accepts only a bare number — verbose output ("The score is 0.8 ...") throws,
 * as does an out-of-range value. A silent default would corrupt the quality
 * signal feeding acceptance.
 */
export function parseJudgeScore(raw: string): number {
  const trimmed = raw.trim();
  if (!/^-?\d*\.?\d+$/.test(trimmed)) {
    throw new Error(`parseJudgeScore: non-numeric score reply: ${JSON.stringify(raw.slice(0, 80))}`);
  }
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n < 0 || n > 1) {
    throw new Error(`parseJudgeScore: score out of range [0,1]: ${trimmed}`);
  }
  return n;
}
