import { describe, it, expect } from 'vitest';
import {
  recencyDecay,
  importanceScore,
  graphConnectivity,
  normalizeBm25,
} from '../../src/search/signals.js';

// ---------------------------------------------------------------------------
// recencyDecay
// ---------------------------------------------------------------------------

describe('recencyDecay', () => {
  const MS_PER_DAY = 86_400_000;
  const halfLife = 90;

  // Fixed reference time for deterministic tests
  const now = new Date('2026-03-24T00:00:00Z').getTime();

  it('returns 1.0 for a decision created right now', () => {
    const createdAt = new Date(now).toISOString();
    expect(recencyDecay(createdAt, halfLife, false, now)).toBeCloseTo(1.0, 5);
  });

  it('returns ~0.5 at exactly one half-life (90 days)', () => {
    const createdAt = new Date(now - 90 * MS_PER_DAY).toISOString();
    expect(recencyDecay(createdAt, halfLife, false, now)).toBeCloseTo(0.5, 5);
  });

  it('returns ~0.25 at two half-lives (180 days)', () => {
    const createdAt = new Date(now - 180 * MS_PER_DAY).toISOString();
    expect(recencyDecay(createdAt, halfLife, false, now)).toBeCloseTo(0.25, 5);
  });

  it('returns ~0.794 at 30 days with 90-day half-life', () => {
    const createdAt = new Date(now - 30 * MS_PER_DAY).toISOString();
    const score = recencyDecay(createdAt, halfLife, false, now);
    expect(score).toBeCloseTo(0.7937, 3);
  });

  it('returns 1.0 for pinned decisions regardless of age', () => {
    const createdAt = new Date(now - 365 * MS_PER_DAY).toISOString();
    expect(recencyDecay(createdAt, halfLife, true, now)).toBe(1.0);
  });

  it('returns 1.0 for future timestamps', () => {
    const createdAt = new Date(now + 10 * MS_PER_DAY).toISOString();
    expect(recencyDecay(createdAt, halfLife, false, now)).toBe(1.0);
  });

  it('returns 1.0 when halfLifeDays is 0', () => {
    const createdAt = new Date(now - 30 * MS_PER_DAY).toISOString();
    expect(recencyDecay(createdAt, 0, false, now)).toBe(1.0);
  });
});

// ---------------------------------------------------------------------------
// importanceScore
// ---------------------------------------------------------------------------

describe('importanceScore', () => {
  it('returns 0.5 for null confidence, unpinned', () => {
    expect(importanceScore(null, false)).toBe(0.5);
  });

  it('returns 0.5 for undefined confidence, unpinned', () => {
    expect(importanceScore(undefined, false)).toBe(0.5);
  });

  it('returns confidence value directly when unpinned', () => {
    expect(importanceScore(0.8, false)).toBe(0.8);
    expect(importanceScore(0.3, false)).toBe(0.3);
  });

  it('doubles and clamps for pinned decision', () => {
    expect(importanceScore(0.8, true)).toBe(1.0); // 0.8 * 2 = 1.6, clamped
    expect(importanceScore(0.4, true)).toBe(0.8); // 0.4 * 2 = 0.8
  });

  it('returns 1.0 for null confidence with pin boost', () => {
    expect(importanceScore(null, true)).toBe(1.0); // 0.5 * 2 = 1.0
  });

  it('clamps negative confidence to 0', () => {
    expect(importanceScore(-0.5, false)).toBe(0.0);
  });
});

// ---------------------------------------------------------------------------
// graphConnectivity
// ---------------------------------------------------------------------------

describe('graphConnectivity', () => {
  it('returns 0 when no results have depends_on', () => {
    const results = [
      { id: 'a', depends_on: [] },
      { id: 'b', depends_on: [] },
    ];
    expect(graphConnectivity('a', results)).toBe(0);
    expect(graphConnectivity('b', results)).toBe(0);
  });

  it('returns 1.0 for the most-referenced decision', () => {
    const results = [
      { id: 'a', depends_on: [] },
      { id: 'b', depends_on: ['a'] },
      { id: 'c', depends_on: ['a'] },
    ];
    // a has 2 inbound, b and c have 0; max = 2
    // graphConnectivity('a') = log1p(2) / log1p(2) = 1.0
    expect(graphConnectivity('a', results)).toBeCloseTo(1.0, 5);
  });

  it('returns 0 for a decision with no inbound references', () => {
    const results = [
      { id: 'a', depends_on: [] },
      { id: 'b', depends_on: ['a'] },
      { id: 'c', depends_on: ['a'] },
    ];
    expect(graphConnectivity('b', results)).toBe(0);
  });

  it('returns value between 0 and 1 for partial connectivity', () => {
    const results = [
      { id: 'a', depends_on: [] },
      { id: 'b', depends_on: ['a'] },
      { id: 'c', depends_on: ['a', 'b'] },
      { id: 'd', depends_on: ['a'] },
    ];
    // a has 3 inbound, b has 1 inbound; max = 3
    const scoreB = graphConnectivity('b', results);
    expect(scoreB).toBeGreaterThan(0);
    expect(scoreB).toBeLessThan(1);
    // log1p(1) / log1p(3) = 0.6931 / 1.3863 ≈ 0.5
    expect(scoreB).toBeCloseTo(Math.log1p(1) / Math.log1p(3), 5);
  });

  it('handles missing depends_on gracefully', () => {
    const results = [
      { id: 'a' },
      { id: 'b' },
    ] as Array<{ id: string; depends_on?: string[] }>;
    expect(graphConnectivity('a', results)).toBe(0);
  });

  it('only counts references to decisions within the result set', () => {
    const results = [
      { id: 'a', depends_on: [] },
      { id: 'b', depends_on: ['a', 'external-id'] },
    ];
    // 'a' has 1 inbound (from b), 'external-id' is not in set
    expect(graphConnectivity('a', results)).toBeCloseTo(1.0, 5);
  });
});

// ---------------------------------------------------------------------------
// normalizeBm25
// ---------------------------------------------------------------------------

describe('normalizeBm25', () => {
  it('returns empty array for empty input', () => {
    expect(normalizeBm25([])).toEqual([]);
  });

  it('returns [0.5] for a single score', () => {
    expect(normalizeBm25([5.0])).toEqual([0.5]);
  });

  it('normalizes to [0, 1] range via min-max', () => {
    const result = normalizeBm25([2, 4, 6]);
    expect(result).toEqual([0, 0.5, 1]);
  });

  it('returns all 0.5 when all scores are equal', () => {
    const result = normalizeBm25([3, 3, 3]);
    expect(result).toEqual([0.5, 0.5, 0.5]);
  });

  it('handles negative scores', () => {
    const result = normalizeBm25([-2, 0, 2]);
    expect(result).toEqual([0, 0.5, 1]);
  });

  it('preserves order', () => {
    const result = normalizeBm25([10, 5, 0, 7.5]);
    expect(result[0]).toBe(1.0); // 10 = max
    expect(result[2]).toBe(0.0); // 0  = min
    expect(result[1]).toBeCloseTo(0.5, 5);
    expect(result[3]).toBeCloseTo(0.75, 5);
  });
});
