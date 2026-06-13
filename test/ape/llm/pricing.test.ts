/**
 * 285/T002: pricing table contract.
 *
 * Pure cost arithmetic over the three pinned model slugs. No I/O.
 */
import { describe, it, expect } from 'vitest';
import { costUsd, PRICE, type ModelSlug } from '../../../src/ape/llm/pricing.js';

const WORKER: ModelSlug = 'anthropic/claude-haiku-4.5';
const JUDGE: ModelSlug = 'anthropic/claude-opus-4-8';

describe('pricing — costUsd', () => {
  it('computes asymmetric in/out cost', () => {
    const p = PRICE[WORKER];
    // 1M input + 1M output → inUsdPerM + outUsdPerM
    const got = costUsd(WORKER, 1_000_000, 1_000_000);
    expect(got).toBeCloseTo(p.inUsdPerM + p.outUsdPerM, 10);
    // asymmetry: output must cost strictly more than input for these slugs
    expect(p.outUsdPerM).toBeGreaterThan(p.inUsdPerM);
  });

  it('cached input billed at cached rate', () => {
    const p = PRICE[JUDGE];
    // 1M cached input tokens, billed at cachedInUsdPerM, nothing else
    const got = costUsd(JUDGE, 0, 0, 1_000_000);
    expect(got).toBeCloseTo(p.cachedInUsdPerM, 10);
    // cached read must be cheaper than fresh input
    expect(p.cachedInUsdPerM).toBeLessThan(p.inUsdPerM);
  });

  it('mixes fresh input, cached input, and output', () => {
    const p = PRICE[WORKER];
    const got = costUsd(WORKER, 2_000_000, 500_000, 1_000_000);
    const want =
      (2_000_000 * p.inUsdPerM + 500_000 * p.outUsdPerM + 1_000_000 * p.cachedInUsdPerM) /
      1_000_000;
    expect(got).toBeCloseTo(want, 10);
  });

  it('unknown slug throws (fail-loud)', () => {
    expect(() => costUsd('anthropic/not-a-real-model' as ModelSlug, 1, 1)).toThrow();
  });

  it('PRICE covers exactly the three pinned slugs', () => {
    expect(Object.keys(PRICE).sort()).toEqual(
      [
        'anthropic/claude-haiku-4.5',
        'anthropic/claude-opus-4-8',
        'anthropic/claude-opus-4-8',
      ]
        .filter((v, i, a) => a.indexOf(v) === i)
        .sort(),
    );
  });
});
