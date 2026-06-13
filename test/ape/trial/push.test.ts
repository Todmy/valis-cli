/**
 * 285/T009: push-axis trial.
 *
 * runPushTrial(variant, item, deps) simulates the push (augment.ts) path: it
 * builds a `<valis_search_results>` block via the REAL
 * composeSearchResultsBlock serializer (NOT reimplemented), uses variant.text
 * to parameterise the injection preamble, prepends the block to item.prompt,
 * sends it to the worker, then detects whether the worker ACTED on the
 * injection (adapter.detectToolCall fired) → mechanical.acted. Cost recorded.
 *
 * No live calls — the gateway is a stub returning a canned worker response.
 */
import { describe, it, expect, vi } from 'vitest';
import { runPushTrial } from '../../../src/ape/trial/push.js';
import { ClaudeCodeAdapter } from '../../../src/ape/agents/claude-code.js';
import type { ApeCorpusItem, PromptVariant } from '../../../src/ape/types.js';

const item: ApeCorpusItem = {
  id: 'item-1',
  prompt: 'Add a new auth flow for the dashboard.',
  should_consult: false,
  should_inject: true,
  stratum: 'normal',
  label_source: 'llm_proposed',
  needs_human_confirm: true,
};

const variant: PromptVariant = {
  id: 'variant-1',
  surface: 'push_injection_template',
  text: 'UNIQUE-PREAMBLE-MARKER act on the team decisions below before coding',
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

describe('runPushTrial', () => {
  it('composes <hit> block (not <result>)', async () => {
    const deps = makeDeps(textResponse('ok'), 0.0);
    await runPushTrial(variant, item, deps);
    const sent = deps.callWorker.mock.calls[0][0] as {
      messages: { role: string; content: string }[];
    };
    const userMsg = sent.messages.find((m) => m.role === 'user')!.content;
    expect(userMsg).toContain('<valis_search_results');
    expect(userMsg).toContain('<hit');
    expect(userMsg).not.toContain('<result');
  });

  it('acted=true when worker follows injection with a valis call', async () => {
    const deps = makeDeps(toolCallResponse('mcp__valis__valis_search'), 0.002);
    const result = await runPushTrial(variant, item, deps);
    expect(result.mechanical.acted).toBe(true);
    expect(result.itemId).toBe('item-1');
    expect(result.variantId).toBe('variant-1');
    expect(result.costUsd).toBe(0.002);
  });

  it('acted=false when worker ignores injection', async () => {
    const deps = makeDeps(textResponse('I will just write the code, no need to consult.'), 0.001);
    const result = await runPushTrial(variant, item, deps);
    expect(result.mechanical.acted).toBe(false);
  });

  it('reuses real composeSearchResultsBlock (assert block shape)', async () => {
    const deps = makeDeps(textResponse('ok'), 0.0);
    await runPushTrial(variant, item, deps);
    const sent = deps.callWorker.mock.calls[0][0] as {
      messages: { role: string; content: string }[];
    };
    const userMsg = sent.messages.find((m) => m.role === 'user')!.content;
    // Envelope + preamble + the corpus prompt are all present.
    expect(userMsg).toContain('purpose="');
    expect(userMsg).toContain('for_prompt="');
    expect(userMsg).toContain('</valis_search_results>');
    expect(userMsg).toContain(variant.text);
    expect(userMsg).toContain(item.prompt);
  });
});
