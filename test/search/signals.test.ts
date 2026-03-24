import { describe, it, expect } from 'vitest';
import {
  recencyDecay,
  importanceScore,
  graphConnectivity,
  computeInboundCounts,
  normalizeBm25,
} from '../../src/search/signals.js';
import type { SearchResult } from '../../src/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function daysAgo(days: number, now: number = Date.now()): string {
  return new Date(now - days * 86_400_000).toISOString();
}

function makeResult(overrides: Partial<SearchResult> = {}): SearchResult {
  return {
    id: overrides.id ?? 'r1',
    score: overrides.score ?? 0.8,
    type: overrides.type ?? 'decision',
    summary: overrides.summary ?? 'test',
    detail: overrides.detail ?? 'test detail',
    author: overrides.author ?? 'alice',
    affects: overrides.affects ?? ['auth'],
    created_at: overrides.created_at ?? new Date().toISOString(),
    status: overrides.status ?? 'active',
    confidence: overrides.confidence ?? null,
    pinned: overrides.pinned ?? false,
    depends_on: overrides.depends_on ?? [],
  };
}

// ---------------------------------------------------------------------------
// recencyDecay
// ---------------------------------------------------------------------------

describe('recencyDecay', () => {
  const now = Date.now();

  it('returns 1.0 for a brand-new decision (0 days)', () => {
    const createdAt = new Date(now).toISOString();
    expect(recencyDecay(createdAt, 90, false, now)).toBeCloseTo(1.0, 5);
  });

  it('returns ~0.5 at half-life (90 days)', () => {
    const createdAt = daysAgo(90, now);
    expect(recencyDecay(createdAt, 90, false, now)).toBeCloseTo(0.5, 2);
  });

  it('returns ~0.25 at 2x half-life (180 days)', () => {
    const createdAt = daysAgo(180, now);
    expect(recencyDecay(createdAt, 90, false, now)).toBeCloseTo(0.25, 2);
  });

  it('returns ~0.794 at 30 days with 90-day half-life', () => {
    const createdAt = daysAgo(30, now);
    expect(recencyDecay(createdAt, 90, false, now)).toBeCloseTo(0.794, 2);
  });

  it('returns 1.0 for pinned decisions regardless of age', () => {
    const createdAt = daysAgo(365, now);
    expect(recencyDecay(createdAt, 90, true, now)).toBe(1.0);
  });

  it('returns 1.0 for future dates', () => {
    const futureDate = new Date(now + 86_400_000).toISOString();
    expect(recencyDecay(futureDate, 90, false, now)).toBe(1.0);
  });

  it('handles custom half-life (60 days)', () => {
    const createdAt = daysAgo(60, now);
    expect(recencyDecay(createdAt, 60, false, now)).toBeCloseTo(0.5, 2);
  });
});

// ---------------------------------------------------------------------------
// importanceScore
// ---------------------------------------------------------------------------

describe('importanceScore', () => {
  it('returns 0.5 for null confidence, unpinned', () => {
    expect(importanceScore(null, false)).toBeCloseTo(0.5, 5);
  });

  it('returns confidence directly when unpinned', () => {
    expect(importanceScore(0.8, false)).toBeCloseTo(0.8, 5);
  });

  it('returns 2x confidence when pinned', () => {
    expect(importanceScore(0.4, true)).toBeCloseTo(0.8, 5);
  });

  it('caps at 1.0 when pinned with high confidence', () => {
    expect(importanceScore(0.8, true)).toBe(1.0);
    expect(importanceScore(1.0, true)).toBe(1.0);
  });

  it('returns 1.0 for pinned with null confidence (0.5 * 2)', () => {
    expect(importanceScore(null, true)).toBe(1.0);
  });

  it('returns 0.0 for zero confidence, unpinned', () => {
    expect(importanceScore(0, false)).toBe(0.0);
  });

  it('handles undefined confidence like null', () => {
    expect(importanceScore(undefined, false)).toBeCloseTo(0.5, 5);
  });
});

// ---------------------------------------------------------------------------
// graphConnectivity
// ---------------------------------------------------------------------------

describe('graphConnectivity', () => {
  it('returns 0.0 when no results have depends_on', () => {
    const results = [makeResult({ id: 'a' }), makeResult({ id: 'b' })];
    expect(graphConnectivity('a', results)).toBe(0.0);
  });

  it('returns 1.0 for the most-referenced decision', () => {
    const results = [
      makeResult({ id: 'a', depends_on: [] }),
      makeResult({ id: 'b', depends_on: ['a'] }),
      makeResult({ id: 'c', depends_on: ['a'] }),
    ];
    expect(graphConnectivity('a', results)).toBe(1.0);
  });

  it('returns 0.0 for unreferenced decisions when others are referenced', () => {
    const results = [
      makeResult({ id: 'a', depends_on: [] }),
      makeResult({ id: 'b', depends_on: ['a'] }),
      makeResult({ id: 'c', depends_on: [] }),
    ];
    expect(graphConnectivity('c', results)).toBe(0.0);
  });

  it('normalizes between 0 and 1 with log1p', () => {
    const results = [
      makeResult({ id: 'a', depends_on: [] }),
      makeResult({ id: 'b', depends_on: ['a'] }),
      makeResult({ id: 'c', depends_on: ['a'] }),
      makeResult({ id: 'd', depends_on: ['a', 'b'] }),
    ];
    // 'a' has 3 inbound (b, c, d reference it)
    // 'b' has 1 inbound (d references it)
    const scoreA = graphConnectivity('a', results);
    const scoreB = graphConnectivity('b', results);
    expect(scoreA).toBe(1.0); // max
    expect(scoreB).toBeGreaterThan(0);
    expect(scoreB).toBeLessThan(1.0);
  });

  it('ignores depends_on references to IDs outside the result set', () => {
    const results = [
      makeResult({ id: 'a', depends_on: ['x-outside'] }),
      makeResult({ id: 'b', depends_on: [] }),
    ];
    expect(graphConnectivity('a', results)).toBe(0.0);
    expect(graphConnectivity('b', results)).toBe(0.0);
  });
});

// ---------------------------------------------------------------------------
// computeInboundCounts
// ---------------------------------------------------------------------------

describe('computeInboundCounts', () => {
  it('returns empty map for empty results', () => {
    const counts = computeInboundCounts([]);
    expect(counts.size).toBe(0);
  });

  it('counts inbound references correctly', () => {
    const results = [
      makeResult({ id: 'a', depends_on: [] }),
      makeResult({ id: 'b', depends_on: ['a'] }),
      makeResult({ id: 'c', depends_on: ['a', 'b'] }),
    ];
    const counts = computeInboundCounts(results);
    expect(counts.get('a')).toBe(2); // b and c reference a
    expect(counts.get('b')).toBe(1); // c references b
    expect(counts.get('c')).toBe(0); // nobody references c
  });
});

// ---------------------------------------------------------------------------
// normalizeBm25
// ---------------------------------------------------------------------------

describe('normalizeBm25', () => {
  it('returns empty array for empty input', () => {
    expect(normalizeBm25([])).toEqual([]);
  });

  it('returns [0.5] for single item', () => {
    expect(normalizeBm25([3.5])).toEqual([0.5]);
  });

  it('returns all 0.5 when all scores are equal', () => {
    expect(normalizeBm25([2.0, 2.0, 2.0])).toEqual([0.5, 0.5, 0.5]);
  });

  it('normalizes to [0, 1] range', () => {
    const result = normalizeBm25([1.0, 3.0, 5.0]);
    expect(result[0]).toBeCloseTo(0.0, 5);
    expect(result[1]).toBeCloseTo(0.5, 5);
    expect(result[2]).toBeCloseTo(1.0, 5);
  });

  it('handles zero scores', () => {
    const result = normalizeBm25([0, 0, 4]);
    expect(result[0]).toBeCloseTo(0.0, 5);
    expect(result[1]).toBeCloseTo(0.0, 5);
    expect(result[2]).toBeCloseTo(1.0, 5);
  });
});
