/**
 * 285/T016: OPRO rewriter — ape/optimizer/opro.ts.
 *
 * `OproRewriter` implements `Optimizer.propose(current, feedback)`: it calls the
 * Opus rewriter with the current prompt + the EvalSummary feedback (scores +
 * failingExamples) and returns N candidate `PromptVariant`s — same surface, new
 * id/text. Malformed model output yields an empty array (never thrown), so a
 * flaky rewriter degrades gracefully like the label proposer (#285 robustness).
 *
 * The injected `llm` mirrors the `callGateway` signature; no live calls.
 */
import { describe, it, expect } from 'vitest';
import type {
  GatewayResult,
  GatewayRequest,
} from '../../../src/ape/optimizer/opro.js';
import { OproRewriter, OPRO_SYSTEM } from '../../../src/ape/optimizer/opro.js';
import type { Optimizer } from '../../../src/ape/optimizer/optimizer.js';
import type { EvalSummary, PromptVariant } from '../../../src/ape/types.js';

/** Wrap a canned model text into a minimal GatewayResult. */
function result(text: string): GatewayResult {
  return { text, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, costUsd: 0 };
}

/** An llm that returns the same canned text and captures the last request. */
function captureLlm(text: string): {
  llm: (req: GatewayRequest) => Promise<GatewayResult>;
  last: () => GatewayRequest | undefined;
} {
  let last: GatewayRequest | undefined;
  return {
    llm: async (req: GatewayRequest) => {
      last = req;
      return result(text);
    },
    last: () => last,
  };
}

const current: PromptVariant = {
  id: 'baseline',
  surface: 'pull_tool_description',
  text: "Search the team's shared decision history",
};

const feedback: EvalSummary = {
  consultPrecision: 0.5,
  consultRecall: 0.4,
  injectActionRate: 0.6,
  nearBoundaryFpRate: 0.3,
  failingExamples: [
    { prompt: 'implement the PRD for auth', expected: 'consult', got: 'no consult' },
  ],
};

describe('OproRewriter', () => {
  it('returns N candidates', async () => {
    const { llm } = captureLlm(
      JSON.stringify([
        { text: 'Search the team brain before acting' },
        { text: 'Consult prior team decisions for this task' },
      ]),
    );
    const opt = new OproRewriter(llm);
    const candidates = await opt.propose(current, feedback);
    expect(candidates).toHaveLength(2);
  });

  it('candidates keep surface', async () => {
    const { llm } = captureLlm(JSON.stringify([{ text: 'variant A' }, { text: 'variant B' }]));
    const opt = new OproRewriter(llm);
    const candidates = await opt.propose(current, feedback);
    for (const c of candidates) {
      expect(c.surface).toBe('pull_tool_description');
      expect(c.id).not.toBe(current.id);
      expect(typeof c.text).toBe('string');
    }
    // Distinct ids per candidate.
    expect(new Set(candidates.map((c) => c.id)).size).toBe(candidates.length);
  });

  it('prompt includes failing examples', async () => {
    const { llm, last } = captureLlm(JSON.stringify([{ text: 'x' }]));
    const opt = new OproRewriter(llm);
    await opt.propose(current, feedback);
    const sent = last();
    expect(sent).toBeDefined();
    const userContent = sent!.messages.map((m) => m.content).join('\n');
    expect(userContent).toContain('implement the PRD for auth');
    // Current prompt text is carried so the rewriter knows what it is improving.
    expect(userContent).toContain("Search the team's shared decision history");
  });

  it('malformed model output → empty array, no throw', async () => {
    const { llm } = captureLlm('not a json array at all');
    const opt = new OproRewriter(llm);
    const candidates = await opt.propose(current, feedback);
    expect(candidates).toEqual([]);
  });

  it('OPRO_SYSTEM instructs a JSON-array reply', () => {
    expect(OPRO_SYSTEM.toLowerCase()).toContain('json array');
  });

  it('OproRewriter satisfies the Optimizer interface', () => {
    const { llm } = captureLlm('[]');
    const opt: Optimizer = new OproRewriter(llm);
    expect(typeof opt.propose).toBe('function');
  });
});
