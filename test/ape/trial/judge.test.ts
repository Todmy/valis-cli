/**
 * 285/T010: cascade Opus judge.
 *
 * judgeQuality(item, trial, axis, llm) calls Opus with a STABLE cache-prefixed
 * system prompt (rubric + few-shot, byte-identical across calls so the prefix
 * caches) and a minimal user delta (the trial output). It instructs the model
 * to reply with ONLY a number 0..1, parses that number, and throws (fail-loud)
 * on non-numeric output. Mechanical labels are NOT judged here (cascade: free).
 *
 * No live calls — the `llm` is a stub recording the request it received.
 */
import { describe, it, expect, vi } from 'vitest';
import { judgeQuality, JUDGE_SYSTEM, type JudgeLlm } from '../../../src/ape/trial/judge.js';
import type { ApeCorpusItem, TrialResult } from '../../../src/ape/types.js';

const item: ApeCorpusItem = {
  id: 'item-1',
  prompt: 'How did we decide to handle auth tokens?',
  should_consult: true,
  should_inject: false,
  stratum: 'normal',
  label_source: 'llm_proposed',
  needs_human_confirm: true,
};

const trial: TrialResult = {
  itemId: 'item-1',
  variantId: 'variant-1',
  mechanical: { consulted: true, acted: false },
  rawOutput: 'I will search the team decision history for auth-token handling.',
  costUsd: 0.001,
};

/** Build a stub llm returning a fixed text + cost, recording requests. */
function makeLlm(text: string, costUsd = 0.002): JudgeLlm {
  return vi.fn(async (_req) => ({ text, costUsd }));
}

describe('judgeQuality', () => {
  it('parses bare numeric score', async () => {
    const llm = makeLlm('0.15');
    const result = await judgeQuality(item, trial, 'consult', llm);
    expect(result.axis).toBe('consult');
    expect(result.score).toBeCloseTo(0.15);
  });

  it('rejects verbose output (throws)', async () => {
    const llm = makeLlm('The score is 0.8 because the agent acted well.');
    await expect(judgeQuality(item, trial, 'consult', llm)).rejects.toThrow();
  });

  it('system prefix is byte-identical across two calls', async () => {
    const llm = makeLlm('0.5') as ReturnType<typeof vi.fn>;
    await judgeQuality(item, trial, 'consult', llm as unknown as JudgeLlm);
    await judgeQuality(item, trial, 'inject', llm as unknown as JudgeLlm);
    const systemA = llm.mock.calls[0][0].system;
    const systemB = llm.mock.calls[1][0].system;
    expect(systemA).toBe(systemB);
    expect(systemA).toBe(JUDGE_SYSTEM);
  });

  it('low max_tokens set', async () => {
    const llm = makeLlm('0.5') as ReturnType<typeof vi.fn>;
    await judgeQuality(item, trial, 'consult', llm as unknown as JudgeLlm);
    const req = llm.mock.calls[0][0];
    expect(req.maxTokens).toBeLessThanOrEqual(8);
  });
});
