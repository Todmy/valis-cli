/**
 * 285/T008: pull-axis trial.
 *
 * runPullTrial(variant, item, deps) builds a worker chat request: a minimal
 * agent harness system prompt PLUS the candidate `valis_search` tool schema
 * whose `description` = variant.text; user = item.prompt. It calls the worker
 * (Haiku via the injected gateway), runs adapter.detectToolCall over the raw
 * response → mechanical.consulted, and records costUsd.
 *
 * No live calls — the gateway is a stub returning a canned worker response.
 */
import { describe, it, expect, vi } from 'vitest';
import { runPullTrial } from '../../../src/ape/trial/pull.js';
import { ClaudeCodeAdapter } from '../../../src/ape/agents/claude-code.js';
import type { ApeCorpusItem, PromptVariant } from '../../../src/ape/types.js';

const item: ApeCorpusItem = {
  id: 'item-1',
  prompt: 'How did we decide to handle auth tokens?',
  should_consult: true,
  should_inject: false,
  stratum: 'normal',
  label_source: 'llm_proposed',
  needs_human_confirm: true,
};

const variant: PromptVariant = {
  id: 'variant-1',
  surface: 'pull_tool_description',
  text: 'UNIQUE-DESC-MARKER search the team decision history before acting',
};

const toolCallResponse = (name: string) => ({
  choices: [
    {
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [{ type: 'function', function: { name, arguments: '{"query":"x"}' } }],
      },
    },
  ],
});

const textResponse = (text: string) => ({
  choices: [{ message: { role: 'assistant', content: text } }],
});

/** Build deps with a stub worker call that returns a fixed raw response + cost. */
function makeDeps(rawResponse: unknown, costUsd: number) {
  const callWorker = vi.fn(async (_req: unknown) => ({ raw: rawResponse, costUsd }));
  return { adapter: new ClaudeCodeAdapter(), callWorker };
}

describe('runPullTrial', () => {
  it('consulted=true when worker emits valis_search call', async () => {
    const deps = makeDeps(toolCallResponse('mcp__valis__valis_search'), 0.001);
    const result = await runPullTrial(variant, item, deps);
    expect(result.mechanical.consulted).toBe(true);
    expect(result.itemId).toBe('item-1');
    expect(result.variantId).toBe('variant-1');
  });

  it('consulted=false on plain answer', async () => {
    const deps = makeDeps(textResponse('Here is a direct answer, no tool needed.'), 0.0005);
    const result = await runPullTrial(variant, item, deps);
    expect(result.mechanical.consulted).toBe(false);
  });

  it('costUsd recorded', async () => {
    const deps = makeDeps(textResponse('plain'), 0.0042);
    const result = await runPullTrial(variant, item, deps);
    expect(result.costUsd).toBe(0.0042);
  });

  it('variant.text appears in the tool description sent', async () => {
    const deps = makeDeps(textResponse('plain'), 0.0);
    await runPullTrial(variant, item, deps);
    expect(deps.callWorker).toHaveBeenCalledTimes(1);
    const sent = deps.callWorker.mock.calls[0][0] as {
      system: string;
      messages: { role: string; content: string }[];
      tools: { function: { name: string; description: string } }[];
    };
    const valisTool = sent.tools.find((t) => t.function.name.includes('valis_search'));
    expect(valisTool).toBeDefined();
    expect(valisTool!.function.description).toBe(variant.text);
    // user message carries the corpus prompt
    expect(sent.messages.some((m) => m.role === 'user' && m.content === item.prompt)).toBe(true);
  });
});
