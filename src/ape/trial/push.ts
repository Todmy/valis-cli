/**
 * 285/RT5: push-axis trial — brief-builder + decision-parser.
 *
 * Measures whether an INJECTED `<valis_search_results>` block drives the real
 * model (a worker subagent, spawned by the in-session orchestration) to ACT on
 * the injected context. Per the 2026-06-14 pivot (design.md §3), the LLM call is
 * NOT made here: TS keeps the two PURE halves of the trial —
 *  - `buildPushBrief` composes the block with the REAL hook serializer
 *    `composeSearchResultsBlock` (never a reimplementation — keeps the FR-015
 *    hook path untouched), frames it with the candidate `variant.text`, prepends
 *    block+frame to the decision turn (the last turn), and carries a
 *    structured-output schema `{ acts_on_injection }`;
 *  - `parsePushDecision` interprets the worker's returned decision → mechanical
 *    `acted: bool`, failing loud on unparseable output.
 *
 * The multi-turn scenario is delivered as a single brief: prior turns are
 * context, the last turn (with the injection block prepended) is the actual ask.
 *
 * NOTE: `WorkerBrief`/`WorkerTool` are the canonical types in `ape/types.ts`
 * (promoted by RT9).
 */

import {
  composeSearchResultsBlock,
  type SearchResultRow,
} from '../../hooks/inject-block.js';
import { JUDGE_SYSTEM, parseJudgeScore } from './judge.js';
import type { ApeScenario, PromptVariant, WorkerBrief, WorkerTool } from '../types.js';

/**
 * Fallback synthetic hit, used ONLY when a scenario carries no `injected_hits`.
 *
 * RT17 (F8): a FIXED hit is off-topic for most prompts, so a capable model
 * correctly ignores it and `injectActionRate` collapses to "blind compliance to
 * irrelevant injection" (always ~0). Prefer per-scenario RELEVANT hits
 * (`scenario.injected_hits`); this fixture survives only as a last resort so a
 * corpus authored without hits still produces a (clearly off-topic) block.
 */
const FALLBACK_ROW: SearchResultRow = {
  id: 'd-fixture',
  summary: 'Auth tokens are stored server-side only; never expose them to the client.',
  type: 'decision',
  status: 'active',
  score: 0.92,
  affects: ['auth'],
};

/** Map a scenario's relevant `injected_hits` to the hook serializer's row shape. */
function rowsFor(scenario: ApeScenario): SearchResultRow[] {
  if (scenario.injected_hits && scenario.injected_hits.length > 0) {
    return scenario.injected_hits.map((h) => ({
      id: h.id,
      summary: h.summary,
      type: h.type,
      status: h.status,
      score: h.score,
      affects: h.affects,
    }));
  }
  return [FALLBACK_ROW];
}

/** The valis tool offered to the worker so it has a way to ACT on the injection. */
const VALIS_TOOL: WorkerTool = {
  name: 'mcp__valis__valis_search',
  description: 'Search the team decision history.',
  parameters: {
    type: 'object',
    properties: { query: { type: 'string' } },
    required: ['query'],
  },
};

/**
 * RT20 (F10): the push worker now produces a real ANSWER, not a self-reported
 * boolean. "Acting on an injection" is whether the answer is SHAPED by the
 * injected decision — a quality judgement an Opus judge makes (`scorePushAnswer`),
 * not a tool-call the worker self-reports. (Self-report measured the wrong thing:
 * a relevant injected decision that merely confirms the answer needs no tool call,
 * so the old `acts_on_injection` collapsed to ~0 regardless of relevance.)
 */
const PUSH_SCHEMA =
  'Answer the developer\'s current message in 1-3 sentences (a brief plan or ' +
  'direct answer). If the injected team-decision block is relevant, your answer ' +
  'should reflect it. Reply with ONLY your answer text — no preamble, no JSON.';

/** Push "acted" threshold: judge score ≥ this counts as acting on the injection. */
export const PUSH_ACTED_THRESHOLD = 0.5;

/**
 * Build the push-trial worker brief from a scenario + candidate variant.
 *
 * Prior turns `[0..n-2]` become `context`; the last turn is the `decisionTurn`,
 * with the `<valis_search_results>` block (built by the REAL serializer) and the
 * candidate `variant.text` preamble prepended — mirroring how augment.ts prepends
 * the block ahead of the user's prompt.
 */
export function buildPushBrief(scenario: ApeScenario, variant: PromptVariant): WorkerBrief {
  const turns = scenario.turns;
  const lastTurn = turns[turns.length - 1];
  const context = turns.slice(0, -1).join('\n');

  // Build the injection block with the REAL hook serializer — do NOT
  // reimplement it. promptHash is opaque; the scenario id suffices. Inject the
  // scenario's RELEVANT hits when present (RT17), else the off-topic fallback.
  const block = composeSearchResultsBlock(rowsFor(scenario), scenario.id);

  // variant.text is the optimized preamble; the block follows; the last turn is
  // the actual user task. Mirrors how augment.ts prepends the block.
  const decisionTurn = [variant.text, block, lastTurn].filter(Boolean).join('\n\n');

  return {
    context,
    decisionTurn,
    tools: [VALIS_TOOL],
    schema: PUSH_SCHEMA,
    // RT20: judge scaffold for stage 2 — the session builds the judge prompt as
    // JUDGE_SYSTEM + `AXIS inject / TASK <task> / OUTPUT <worker answer> / SCORE:`
    // (mirrors judge.ts::buildJudgeBrief) and records the judge's numeric reply.
    judge: { system: JUDGE_SYSTEM, task: lastTurn },
  };
}

/**
 * RT20 (F10) — stage 2: interpret the JUDGE's score of the worker's answer into
 * the mechanical `acted` label. `acted` = the judge scored the answer's adherence
 * to the injected decision at or above `PUSH_ACTED_THRESHOLD`. Fail-loud on a
 * non-numeric / out-of-range judge reply (via `parseJudgeScore`).
 */
export function scorePushAnswer(judgeReply: unknown): { acted: boolean; score: number } {
  const score = parseJudgeScore(typeof judgeReply === 'string' ? judgeReply : String(judgeReply));
  return { acted: score >= PUSH_ACTED_THRESHOLD, score };
}

/** The worker's structured push decision once parsed. */
export interface PushDecision {
  acted: boolean;
}

/**
 * Parse the worker's structured decision into `{ acted }`.
 *
 * Accepts either a raw JSON string or an already-parsed object. Throws (fail-loud,
 * 021 pattern) on unparseable JSON or a missing/non-boolean `acts_on_injection` —
 * a silent default would corrupt the mechanical signal feeding the metrics.
 */
export function parsePushDecision(raw: unknown): PushDecision {
  let obj: unknown = raw;
  if (typeof raw === 'string') {
    try {
      obj = JSON.parse(raw);
    } catch (err) {
      throw new Error(`parsePushDecision: unparseable worker output — ${(err as Error).message}`);
    }
  }

  if (obj === null || typeof obj !== 'object') {
    throw new Error('parsePushDecision: worker output is not an object');
  }

  const actsOnInjection = (obj as Record<string, unknown>).acts_on_injection;
  if (typeof actsOnInjection !== 'boolean') {
    throw new Error('parsePushDecision: missing or non-boolean `acts_on_injection`');
  }

  return { acted: actsOnInjection };
}
