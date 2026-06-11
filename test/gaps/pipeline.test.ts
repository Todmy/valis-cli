/**
 * 045/T012: pipeline behavior (canned client + candle-store fixture).
 *
 * These assert the engine's OWN transformations on known canned stage outputs
 * (lesson 761661a4 — not assert-on-mock): the top-N cap, the structural
 * register, exclude-existing dedup, the absence gate, the budget bound, and the
 * "no gaps → empty, never fabricate" contract.
 */
import { describe, it, expect } from 'vitest';
import { runGapPipeline, type GapPipelineDeps } from '../../src/gaps/pipeline.js';
import { loadCuratedArchetypes } from '../../src/gaps/schema.js';
import { DEFAULT_GAPS_CONFIG } from '../../src/gaps/config.js';
import { makeCannedClient, type CannedScript } from './canned-client.js';
import { candleStoreDecisions, candleStoreScript } from './fixtures/candle-store.js';

const curated = loadCuratedArchetypes();

function deps(overrides: Partial<GapPipelineDeps> & { script?: CannedScript } = {}): {
  deps: GapPipelineDeps;
  client: ReturnType<typeof makeCannedClient>;
} {
  const client = makeCannedClient(overrides.script ?? candleStoreScript);
  return {
    client,
    deps: {
      llm: client,
      searchAbsence: overrides.searchAbsence ?? (async () => false),
      existingComponents: overrides.existingComponents ?? new Set<string>(),
      config: overrides.config ?? DEFAULT_GAPS_CONFIG,
      curated,
      truncated: overrides.truncated,
    },
  };
}

describe('runGapPipeline — candle store (US1)', () => {
  it('returns at most TOP_N questions, all interrogative + grounded + why-asking (SC-001)', async () => {
    const { deps: d } = deps();
    const result = await runGapPipeline(candleStoreDecisions, d);

    expect(result.questions.length).toBeGreaterThan(0);
    expect(result.questions.length).toBeLessThanOrEqual(DEFAULT_GAPS_CONFIG.topNQuestions);
    for (const q of result.questions) {
      expect(q.question).toContain('?');
      expect(q.whyAsking.length).toBeGreaterThan(0);
      expect(q.groundingDecisionIds.length).toBeGreaterThan(0);
      // Grounding snapshot is built from the real decisions, 1:1 with the ids.
      expect(q.groundingSnapshot.length).toBe(q.groundingDecisionIds.length);
      for (const ref of q.groundingSnapshot) {
        expect(candleStoreDecisions.some((dec) => dec.id === ref.decisionId)).toBe(true);
      }
    }
  });

  it('assigns the STANDARD register (e-commerce is curated), independent of reliability', async () => {
    const { deps: d } = deps();
    const result = await runGapPipeline(candleStoreDecisions, d);
    expect(result.register).toBe('standard');
    // reliability passes through to telemetry but did not gate anything.
    expect(result.reliabilityTelemetry).toBe(0.88);
  });

  it('never flags a platform-provided component (cart-checkout, Shopify named) — SC-003', async () => {
    const { deps: d } = deps();
    const result = await runGapPipeline(candleStoreDecisions, d);
    const flagged = result.questions.map((q) => q.archetypeComponent);
    expect(flagged).not.toContain('cart-checkout');
    expect(flagged).not.toContain('payment-processing');
  });

  it('articulates a fork AS a question — never silently resolved (FR-016)', async () => {
    // Fork-only coverage so the cap cannot crowd it out: it must surface.
    const forkOnly: CannedScript = {
      ...candleStoreScript,
      coverage: {
        present: [],
        platformProvided: [],
        absent: [],
        forks: [
          {
            component: 'international-multicurrency',
            importance: 3,
            conditionalOn: 'selling to customers outside the home country',
          },
        ],
      },
    };
    const { deps: d } = deps({ script: forkOnly });
    const result = await runGapPipeline(candleStoreDecisions, d);
    expect(result.questions.map((q) => q.archetypeComponent)).toContain(
      'international-multicurrency',
    );
  });

  it('holds the model-call budget (classify + coverage + articulate = 3 ≤ MAX)', async () => {
    const { deps: d, client } = deps();
    const result = await runGapPipeline(candleStoreDecisions, d);
    expect(result.modelCalls).toBeLessThanOrEqual(DEFAULT_GAPS_CONFIG.maxModelCalls);
    expect(client.calls).toEqual({ classify: 1, coverage: 1, articulate: 1 });
  });
});

describe('runGapPipeline — no-gaps and dedup paths', () => {
  it('all-covered fixture → empty questions, articulate never called (FR-007)', async () => {
    const allCovered: CannedScript = {
      ...candleStoreScript,
      coverage: { present: ['returns-refunds'], platformProvided: [], absent: [], forks: [] },
    };
    const { deps: d, client } = deps({ script: allCovered });
    const result = await runGapPipeline(candleStoreDecisions, d);
    expect(result.questions).toEqual([]);
    expect(client.calls.articulate).toBe(0);
    expect(result.modelCalls).toBe(2);
  });

  it('pre-existing components consume zero model attention (FR-019)', async () => {
    // Everything the coverage stage would surface is already an open question.
    const existingComponents = new Set([
      'returns-refunds',
      'tax-calculation',
      'fraud-prevention',
      'international-multicurrency',
    ]);
    const { deps: d, client } = deps({ existingComponents });
    const result = await runGapPipeline(candleStoreDecisions, d);
    expect(result.questions).toEqual([]);
    expect(client.calls.articulate).toBe(0);
  });

  it('absence-gate-positive component is dropped before articulation (FR-017)', async () => {
    // The store already answers returns-refunds — it must not become a question.
    const { deps: d } = deps({
      searchAbsence: async (component) => component === 'returns-refunds',
    });
    const result = await runGapPipeline(candleStoreDecisions, d);
    expect(result.questions.map((q) => q.archetypeComponent)).not.toContain('returns-refunds');
  });

  it('throws model_budget_exceeded when the budget is set below the static call count', async () => {
    const { deps: d } = deps({ config: { ...DEFAULT_GAPS_CONFIG, maxModelCalls: 2 } });
    await expect(runGapPipeline(candleStoreDecisions, d)).rejects.toMatchObject({
      code: 'model_budget_exceeded',
    });
  });
});
