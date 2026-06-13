/**
 * 285/T008: pull-axis trial.
 *
 * Measures whether a candidate `valis_search` tool DESCRIPTION drives the
 * worker (the agent-under-test) to consult Valis. We send the worker a
 * minimal agent harness system prompt plus the candidate tool schema (its
 * description = `variant.text`) and the corpus prompt as the user turn, then
 * run `adapter.detectToolCall` over the raw worker response to set
 * `mechanical.consulted`. Cost is propagated from the worker call.
 *
 * The worker call is injected (`deps.callWorker`) so the trial stays a pure,
 * offline orchestration: the live AI Gateway wiring lives in the orchestrator.
 */

import type { AgentAdapter, ApeCorpusItem, PromptVariant, TrialResult } from '../types.js';

/** Minimal agent-harness system prompt — frames the worker as a Claude-Code-like agent. */
const WORKER_SYSTEM =
  'You are a coding agent with access to tools. Use the available tools when ' +
  'they would help you answer the user better. Otherwise answer directly.';

/** The OpenAI-compatible request we hand to the worker. */
export interface PullWorkerRequest {
  system: string;
  messages: { role: 'user' | 'assistant'; content: string }[];
  tools: {
    type: 'function';
    function: { name: string; description: string; parameters: Record<string, unknown> };
  }[];
}

/** Injectable worker call — returns the raw (OpenAI-compatible) response + cost. */
export interface PullTrialDeps {
  adapter: AgentAdapter;
  callWorker(req: PullWorkerRequest): Promise<{ raw: unknown; costUsd: number }>;
}

export async function runPullTrial(
  variant: PromptVariant,
  item: ApeCorpusItem,
  deps: PullTrialDeps,
): Promise<TrialResult> {
  const req: PullWorkerRequest = {
    system: WORKER_SYSTEM,
    messages: [{ role: 'user', content: item.prompt }],
    tools: [
      {
        type: 'function',
        function: {
          // Namespace-agnostic detection keys on `valis_search`; the candidate
          // description (variant.text) is the thing under optimization.
          name: 'mcp__valis__valis_search',
          description: variant.text,
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
    mechanical: { consulted: fired, acted: false },
    rawOutput: typeof raw === 'string' ? raw : JSON.stringify(raw),
    costUsd,
  };
}
