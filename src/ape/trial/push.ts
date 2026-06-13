/**
 * 285/T009: push-axis trial.
 *
 * Measures whether an INJECTED `<valis_search_results>` block drives the worker
 * (the agent-under-test) to ACT on the injected context. We build the block
 * with the REAL hook serializer `composeSearchResultsBlock` — never a
 * reimplementation — so the harness reads the exact push surface without
 * touching it (keeps the FR-015 hook path untouched). `variant.text` is the
 * thing under optimization: it parameterises the preamble prepended ahead of
 * the block. The composed preamble+block is prepended to `item.prompt` as the
 * worker's user turn, then `adapter.detectToolCall` over the raw response sets
 * `mechanical.acted` (MVP mechanical signal = a valis tool call fired).
 *
 * The worker call is injected (`deps.callWorker`) so the trial stays a pure,
 * offline orchestration: the live AI Gateway wiring lives in the orchestrator.
 */

import {
  composeSearchResultsBlock,
  type SearchResultRow,
} from '../../hooks/inject-block.js';
import type { AgentAdapter, ApeCorpusItem, PromptVariant, TrialResult } from '../types.js';

/** Minimal agent-harness system prompt — frames the worker as a Claude-Code-like agent. */
const WORKER_SYSTEM =
  'You are a coding agent with access to tools. Use the available tools when ' +
  'they would help you answer the user better. Otherwise answer directly.';

/**
 * A single synthetic search hit injected into the worker turn. The push trial
 * tests whether the agent ACTS on injected context, so the row content is held
 * fixed and only the surrounding preamble (`variant.text`) varies.
 */
const FIXTURE_ROW: SearchResultRow = {
  id: 'd-fixture',
  summary: 'Auth tokens are stored server-side only; never expose them to the client.',
  type: 'decision',
  status: 'active',
  score: 0.92,
  affects: ['auth'],
};

/** The OpenAI-compatible request we hand to the worker. */
export interface PushWorkerRequest {
  system: string;
  messages: { role: 'user' | 'assistant'; content: string }[];
  tools: {
    type: 'function';
    function: { name: string; description: string; parameters: Record<string, unknown> };
  }[];
}

/** Injectable worker call — returns the raw (OpenAI-compatible) response + cost. */
export interface PushTrialDeps {
  adapter: AgentAdapter;
  callWorker(req: PushWorkerRequest): Promise<{ raw: unknown; costUsd: number }>;
}

export async function runPushTrial(
  variant: PromptVariant,
  item: ApeCorpusItem,
  deps: PushTrialDeps,
): Promise<TrialResult> {
  // Build the injection block with the REAL hook serializer — do NOT
  // reimplement it. promptHash is opaque; the run id of the item suffices.
  const block = composeSearchResultsBlock([FIXTURE_ROW], item.id);

  // variant.text is the optimized preamble; the block follows; the corpus
  // prompt is the actual user task. Mirrors how augment.ts prepends the block.
  const injected = [variant.text, block, item.prompt].filter(Boolean).join('\n\n');

  const req: PushWorkerRequest = {
    system: WORKER_SYSTEM,
    messages: [{ role: 'user', content: injected }],
    tools: [
      {
        type: 'function',
        function: {
          name: 'mcp__valis__valis_search',
          description: 'Search the team decision history.',
          parameters: {
            type: 'object',
            properties: { query: { type: 'string' } },
            required: ['query'],
          },
        },
      },
    ],
  };

  const { raw, costUsd } = await deps.callWorker(req);
  const { fired } = deps.adapter.detectToolCall(raw);

  return {
    itemId: item.id,
    variantId: variant.id,
    mechanical: { consulted: false, acted: fired },
    rawOutput: typeof raw === 'string' ? raw : JSON.stringify(raw),
    costUsd,
  };
}
