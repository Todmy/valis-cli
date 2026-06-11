/**
 * 045/T021: false-positive discipline (US2, SC-003).
 *
 * Unit-level assertions on `classifyComponents` (the deterministic safety net)
 * plus an end-to-end pass through the pipeline proving the candle store's
 * platform-provided cart is never flagged and a store-answered component is
 * dropped by the absence gate. Asserts on fixture outcomes, not on mocks
 * (lesson 761661a4).
 */
import { describe, it, expect } from 'vitest';
import { classifyComponents } from '../../src/gaps/coverage.js';
import { runGapPipeline } from '../../src/gaps/pipeline.js';
import { loadCuratedArchetypes } from '../../src/gaps/schema.js';
import { DEFAULT_GAPS_CONFIG } from '../../src/gaps/config.js';
import type { CoverageResult } from '../../src/gaps/llm.js';
import { makeCannedClient } from './canned-client.js';
import { candleStoreDecisions, candleStoreScript } from './fixtures/candle-store.js';

const curated = loadCuratedArchetypes();
const ecommerce = curated.get('e-commerce')!;

describe('classifyComponents (US2)', () => {
  it('never lists a platform-provided component as absent (FR-014)', () => {
    const result = classifyComponents(candleStoreScript.coverage, ecommerce);
    const absent = result.absent.map((a) => a.component);
    expect(absent).not.toContain('cart-checkout');
    expect(absent).not.toContain('payment-processing');
    expect(result.platformProvided).toContain('cart-checkout');
  });

  it('never lists a present component as absent', () => {
    const result = classifyComponents(candleStoreScript.coverage, ecommerce);
    const absent = result.absent.map((a) => a.component);
    for (const p of candleStoreScript.coverage.present) {
      expect(absent).not.toContain(p);
    }
  });

  it('surfaces a conditional component as a fork, never a plain gap (FR-016)', () => {
    const result = classifyComponents(candleStoreScript.coverage, ecommerce);
    expect(result.forks.map((f) => f.component)).toContain('international-multicurrency');
  });

  it('re-routes an absent-but-conditional component into forks (deterministic net)', () => {
    // The LLM mislabels a conditional archetype component as a plain absent gap;
    // classifyComponents must move it to forks based on the archetype.
    const coverage: CoverageResult = {
      present: [],
      platformProvided: [],
      absent: [{ component: 'age-restricted-goods-verification', importance: 2 }],
      forks: [],
    };
    const result = classifyComponents(coverage, ecommerce);
    expect(result.absent.map((a) => a.component)).not.toContain(
      'age-restricted-goods-verification',
    );
    expect(result.forks.map((f) => f.component)).toContain('age-restricted-goods-verification');
  });

  it('gives present/platform precedence when the LLM double-lists a component', () => {
    const coverage: CoverageResult = {
      present: ['returns-refunds'],
      platformProvided: [],
      absent: [{ component: 'returns-refunds', importance: 4 }],
      forks: [],
    };
    const result = classifyComponents(coverage, ecommerce);
    expect(result.absent.map((a) => a.component)).not.toContain('returns-refunds');
    expect(result.present).toContain('returns-refunds');
  });

  it('keeps genuinely-absent, non-conditional components (returns/tax/fraud)', () => {
    const result = classifyComponents(candleStoreScript.coverage, ecommerce);
    const absent = result.absent.map((a) => a.component);
    expect(absent).toEqual(
      expect.arrayContaining(['returns-refunds', 'tax-calculation', 'fraud-prevention']),
    );
  });
});

describe('end-to-end false-positive discipline (SC-003)', () => {
  it('the platform-provided cart never becomes a question', async () => {
    const client = makeCannedClient(candleStoreScript);
    const result = await runGapPipeline(candleStoreDecisions, {
      llm: client,
      searchAbsence: async () => false,
      existingComponents: new Set(),
      config: DEFAULT_GAPS_CONFIG,
      curated,
    });
    expect(result.questions.map((q) => q.archetypeComponent)).not.toContain('cart-checkout');
  });

  it('a component already answered in the store is dropped by the absence gate', async () => {
    const client = makeCannedClient(candleStoreScript);
    const result = await runGapPipeline(candleStoreDecisions, {
      llm: client,
      searchAbsence: async (component) => component === 'tax-calculation',
      existingComponents: new Set(),
      config: DEFAULT_GAPS_CONFIG,
      curated,
    });
    expect(result.questions.map((q) => q.archetypeComponent)).not.toContain('tax-calculation');
  });
});
