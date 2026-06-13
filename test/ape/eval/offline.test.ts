/**
 * 285/T013: offline trial eval mode.
 *
 * Contract (plan.md Task 13): `evalOffline(variant, corpus, deps)` runs the
 * appropriate trial (pull or push by `variant.surface`) over each corpus item,
 * optionally judges quality axes, aggregates via metrics.ts, and collects
 * `failingExamples`. Accumulates spend through the passed `spend` tracker.
 *
 * Named cases: aggregates metrics over corpus / collects failing examples /
 * routes pull vs push by surface / spend accumulates.
 */

import { describe, it, expect, vi } from 'vitest';
import { evalOffline } from '../../../src/ape/eval/offline.js';
import type {
  ApeCorpusItem,
  PromptVariant,
  TrialResult,
} from '../../../src/ape/types.js';

function item(over: Partial<ApeCorpusItem>): ApeCorpusItem {
  return {
    id: over.id ?? 'i',
    prompt: over.prompt ?? 'p',
    should_consult: over.should_consult ?? false,
    should_inject: over.should_inject ?? false,
    stratum: over.stratum ?? 'normal',
    label_source: over.label_source ?? 'llm_proposed',
    needs_human_confirm: over.needs_human_confirm ?? true,
    source_session: over.source_session,
  };
}

function trial(over: Partial<TrialResult>): TrialResult {
  return {
    itemId: over.itemId ?? 'i',
    variantId: over.variantId ?? 'v',
    mechanical: over.mechanical ?? { consulted: false, acted: false },
    judge: over.judge,
    rawOutput: over.rawOutput ?? '',
    costUsd: over.costUsd ?? 0,
  };
}

function makeSpend() {
  let total = 0;
  return {
    add: vi.fn((usd: number) => {
      total += usd;
    }),
    get total() {
      return total;
    },
  };
}

const pullVariant: PromptVariant = {
  id: 'v-pull',
  surface: 'pull_tool_description',
  text: 'Search the team decision history.',
};
const pushVariant: PromptVariant = {
  id: 'v-push',
  surface: 'push_injection_template',
  text: 'Consider this injected context.',
};

describe('evalOffline', () => {
  it('aggregates metrics over corpus', async () => {
    // Two consult-positive items: one consulted (TP), one not (FN) → recall 0.5,
    // precision 1.0 (only the one true consult predicted).
    const corpus = [
      item({ id: 'a', should_consult: true }),
      item({ id: 'b', should_consult: true }),
    ];
    const runPull = vi.fn(async (_v, it: ApeCorpusItem) =>
      trial({
        itemId: it.id,
        mechanical: { consulted: it.id === 'a', acted: false },
        costUsd: 0.01,
      }),
    );
    const spend = makeSpend();

    const summary = await evalOffline(pullVariant, corpus, {
      runPull,
      runPush: vi.fn(),
      spend,
    });

    expect(summary.consultRecall).toBeCloseTo(0.5);
    expect(summary.consultPrecision).toBeCloseTo(1.0);
  });

  it('collects failing examples', async () => {
    // consult-positive item that did NOT consult → a failing example.
    const corpus = [item({ id: 'a', prompt: 'execute the PRD', should_consult: true })];
    const runPull = vi.fn(async (_v, it: ApeCorpusItem) =>
      trial({ itemId: it.id, mechanical: { consulted: false, acted: false } }),
    );
    const spend = makeSpend();

    const summary = await evalOffline(pullVariant, corpus, {
      runPull,
      runPush: vi.fn(),
      spend,
    });

    expect(summary.failingExamples.length).toBeGreaterThan(0);
    expect(summary.failingExamples[0]?.prompt).toBe('execute the PRD');
  });

  it('routes pull vs push by surface', async () => {
    const corpus = [item({ id: 'a', should_inject: true })];
    const runPull = vi.fn(async (_v, it: ApeCorpusItem) =>
      trial({ itemId: it.id, mechanical: { consulted: false, acted: false } }),
    );
    const runPush = vi.fn(async (_v, it: ApeCorpusItem) =>
      trial({ itemId: it.id, mechanical: { consulted: false, acted: true } }),
    );
    const spend = makeSpend();

    await evalOffline(pushVariant, corpus, { runPull, runPush, spend });

    expect(runPush).toHaveBeenCalledTimes(1);
    expect(runPull).not.toHaveBeenCalled();
  });

  it('spend accumulates', async () => {
    const corpus = [item({ id: 'a' }), item({ id: 'b' })];
    const runPull = vi.fn(async (_v, it: ApeCorpusItem) =>
      trial({ itemId: it.id, costUsd: 0.05 }),
    );
    const spend = makeSpend();

    await evalOffline(pullVariant, corpus, { runPull, runPush: vi.fn(), spend });

    expect(spend.add).toHaveBeenCalledTimes(2);
    expect(spend.total).toBeCloseTo(0.1);
  });
});
