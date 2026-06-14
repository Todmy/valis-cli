/**
 * 285/RT4: pull-axis trial — brief-builder + decision-parser.
 *
 * Measures whether a candidate `valis_search` tool DESCRIPTION drives the real
 * model (a worker subagent, spawned by the in-session orchestration) to consult
 * Valis. Per the 2026-06-14 pivot (design.md §3), the LLM call is NOT made here:
 * TS keeps the two PURE halves of the trial —
 *  - `buildPullBrief` assembles the worker brief (prior turns as context + the
 *    final decision turn + the candidate description offered as an available
 *    valis tool + a structured-output schema `{ would_consult, tool }`);
 *  - `parsePullDecision` interprets the worker's returned decision → mechanical
 *    `consulted: bool`, failing loud on unparseable output.
 *
 * The multi-turn scenario is delivered as a single brief: prior turns are
 * context, the last turn is the actual ask. Because the measurement point IS the
 * last turn, there are no post-decision turns to leak.
 *
 * NOTE: `WorkerBrief` / `WorkerTool` are the canonical types in `ape/types.ts`
 * (promoted by RT9); re-exported here so existing `trial/pull.js` consumers keep
 * one source of truth.
 */

import type { ApeScenario, PromptVariant, WorkerBrief, WorkerTool } from '../types.js';

export type { WorkerBrief, WorkerTool } from '../types.js';

/**
 * Structured-output schema the worker must reply with. The orchestration forces
 * this shape; `parsePullDecision` reads it back. Kept as a stable string so it is
 * embeddable verbatim in the subagent brief.
 */
const PULL_SCHEMA =
  '{ "would_consult": boolean, "tool": string | null } — ' +
  'set would_consult=true and name the tool ONLY if you would call a valis tool ' +
  'before answering the last turn; otherwise would_consult=false, tool=null.';

/**
 * Build the pull-trial worker brief from a scenario + candidate variant.
 *
 * Prior turns `[0..n-2]` become `context`; the last turn is the `decisionTurn`.
 * The candidate `variant.text` is offered as the `valis_search` tool description
 * (namespace-agnostic detection keys on `valis_search`) — it is the thing under
 * optimization.
 */
export function buildPullBrief(scenario: ApeScenario, variant: PromptVariant): WorkerBrief {
  const turns = scenario.turns;
  const decisionTurn = turns[turns.length - 1];
  const context = turns.slice(0, -1).join('\n');

  return {
    context,
    decisionTurn,
    tools: [
      {
        name: 'mcp__valis__valis_search',
        description: variant.text,
        parameters: {
          type: 'object',
          properties: { query: { type: 'string' } },
          required: ['query'],
        },
      },
    ],
    schema: PULL_SCHEMA,
  };
}

/** The worker's structured pull decision once parsed. */
export interface PullDecision {
  consulted: boolean;
}

/**
 * Parse the worker's structured decision into `{ consulted }`.
 *
 * Accepts either a raw JSON string or an already-parsed object. Throws (fail-loud,
 * 021 pattern) on unparseable JSON or a missing/non-boolean `would_consult` — a
 * silent default would corrupt the mechanical signal feeding the metrics.
 */
export function parsePullDecision(raw: unknown): PullDecision {
  let obj: unknown = raw;
  if (typeof raw === 'string') {
    try {
      obj = JSON.parse(raw);
    } catch (err) {
      throw new Error(`parsePullDecision: unparseable worker output — ${(err as Error).message}`);
    }
  }

  if (obj === null || typeof obj !== 'object') {
    throw new Error('parsePullDecision: worker output is not an object');
  }

  const wouldConsult = (obj as Record<string, unknown>).would_consult;
  if (typeof wouldConsult !== 'boolean') {
    throw new Error('parsePullDecision: missing or non-boolean `would_consult`');
  }

  return { consulted: wouldConsult };
}
