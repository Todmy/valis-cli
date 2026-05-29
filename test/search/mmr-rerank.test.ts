/**
 * Tests for `mmrRerank` (037-search-mmr-diversity, GitHub issue #120).
 *
 * Pure unit tests over the side-effect-free MMR re-ranker — no Qdrant, no I/O.
 * The diversity signal is Jaccard overlap of `affects[]` tags (the production
 * managed-inference path returns no per-document vectors to the client, so
 * native-vector MMR is not viable — see specs/037-search-mmr-diversity/plan.md).
 *
 * Coverage maps to the spec's acceptance scenarios + success criteria:
 *   - US1 (FR-001..003, SC-001): diverse top-K covers ≥3 distinct affects[] tags
 *   - Edge cases (FR-009): empty / single / pool ≤ k / no-diversity-to-exploit
 *   - US2 (FR-004/005, SC-002/003): first pick = max relevance; λ=1.0 is a no-op
 */

import { describe, it, expect } from 'vitest';
import { mmrRerank } from '../../src/cloud/qdrant/search.js';
import type { SearchResult } from '../../src/types.js';

/** Minimal SearchResult factory — only `id`, `score`, `affects` matter to MMR. */
function makeResult(
  id: string,
  score: number,
  affects: string[],
): SearchResult {
  return {
    id,
    score,
    type: 'decision',
    summary: id,
    detail: id,
    author: 'tester',
    affects,
    created_at: '2026-05-29T00:00:00Z',
  };
}

/** Count distinct affects[] tags across a result set. */
function distinctTags(results: SearchResult[]): Set<string> {
  const tags = new Set<string>();
  for (const r of results) for (const t of r.affects ?? []) tags.add(t);
  return tags;
}

// Fixture A: 5 near-duplicate 'jwt' rows with the top scores, plus 3 distinct
// lower-scored rows. Pre-MMR top-5 by score would be all 5 'jwt' rows (1 tag).
const fixtureA: SearchResult[] = [
  makeResult('jwt-1', 0.99, ['jwt']),
  makeResult('jwt-2', 0.97, ['jwt']),
  makeResult('jwt-3', 0.95, ['jwt']),
  makeResult('jwt-4', 0.93, ['jwt']),
  makeResult('jwt-5', 0.91, ['jwt']),
  makeResult('rls-1', 0.80, ['rls']),
  makeResult('rotation-1', 0.78, ['rotation']),
  makeResult('oauth-1', 0.76, ['oauth']),
];

describe('mmrRerank — US1 diverse top-K (issue #120 headline)', () => {
  it('SC-001: post-MMR top-5 covers ≥3 distinct affects[] tags where pre-MMR covered 1', () => {
    // Pre-MMR (relevance-only) top-5 would be all five jwt rows → 1 tag.
    const preMmr = [...fixtureA].sort((a, b) => b.score - a.score).slice(0, 5);
    expect(distinctTags(preMmr).size).toBe(1);

    const out = mmrRerank(fixtureA, { lambda: 0.5, k: 5 });
    expect(out).toHaveLength(5);
    expect(distinctTags(out).size).toBeGreaterThanOrEqual(3);
  });

  it('keeps the strongest jwt hit while pulling in distinct facets', () => {
    const out = mmrRerank(fixtureA, { lambda: 0.5, k: 5 });
    const ids = out.map((r) => r.id);
    // The single best jwt row survives.
    expect(ids).toContain('jwt-1');
    // The distinct facets are represented.
    const tags = distinctTags(out);
    expect(tags.has('rls')).toBe(true);
    expect(tags.has('rotation')).toBe(true);
    expect(tags.has('oauth')).toBe(true);
  });
});

describe('mmrRerank — edge cases (FR-009 / spec Edge Cases)', () => {
  it('empty input returns []', () => {
    expect(mmrRerank([], { lambda: 0.5, k: 5 })).toEqual([]);
  });

  it('single candidate returned unchanged', () => {
    const one = [makeResult('only', 0.5, ['x'])];
    const out = mmrRerank(one, { lambda: 0.5, k: 5 });
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe('only');
  });

  it('pool size ≤ k returns all candidates, no padding, no error', () => {
    const three = [
      makeResult('a', 0.9, ['x']),
      makeResult('b', 0.8, ['y']),
      makeResult('c', 0.7, ['z']),
    ];
    const out = mmrRerank(three, { lambda: 0.5, k: 5 });
    expect(out).toHaveLength(3);
    expect(new Set(out.map((r) => r.id))).toEqual(new Set(['a', 'b', 'c']));
  });

  it('does not mutate the input array', () => {
    const input = [...fixtureA];
    const snapshot = input.map((r) => r.id);
    mmrRerank(input, { lambda: 0.5, k: 5 });
    expect(input.map((r) => r.id)).toEqual(snapshot);
  });
});

describe('mmrRerank — no diversity to exploit', () => {
  it('all candidates share one tag → output equals relevance ordering, length = min(k, pool)', () => {
    const allSame = [
      makeResult('a', 0.9, ['jwt']),
      makeResult('b', 0.8, ['jwt']),
      makeResult('c', 0.7, ['jwt']),
      makeResult('d', 0.6, ['jwt']),
    ];
    const out = mmrRerank(allSame, { lambda: 0.5, k: 3 });
    expect(out.map((r) => r.id)).toEqual(['a', 'b', 'c']);
  });

  it('all candidates have empty affects[] → degrades to relevance ordering, no error', () => {
    const empty = [
      makeResult('a', 0.9, []),
      makeResult('b', 0.8, []),
      makeResult('c', 0.7, []),
    ];
    const out = mmrRerank(empty, { lambda: 0.5, k: 3 });
    expect(out.map((r) => r.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('mmrRerank — no relevance gradient preserves input order (PR #228 finding 3)', () => {
  it('zero-score mixed-tag pool (scroll fallback) is NOT reordered by Jaccard', () => {
    // Embedding-outage fallback: every score is 0 → range === 0. Without the
    // short-circuit, MMR would reorder by pure diversity and clobber Qdrant's
    // deterministic scroll order. Mixed tags would expose that reordering.
    const scrollOrder = [
      makeResult('s1', 0, ['jwt']),
      makeResult('s2', 0, ['jwt']),
      makeResult('s3', 0, ['rls']),
      makeResult('s4', 0, ['oauth']),
      makeResult('s5', 0, ['rls']),
    ];
    const out = mmrRerank(scrollOrder, { lambda: 0.5, k: 5 });
    // Order must be byte-for-byte the input scroll order, not a diversity shuffle.
    expect(out.map((r) => r.id)).toEqual(['s1', 's2', 's3', 's4', 's5']);
  });

  it('zero-score pool still honours k (trims, preserves order)', () => {
    const scrollOrder = [
      makeResult('s1', 0, ['jwt']),
      makeResult('s2', 0, ['rls']),
      makeResult('s3', 0, ['oauth']),
      makeResult('s4', 0, ['db']),
    ];
    const out = mmrRerank(scrollOrder, { lambda: 0.5, k: 2 });
    expect(out.map((r) => r.id)).toEqual(['s1', 's2']);
  });

  it('uniform non-zero scores (range 0) also preserve input order', () => {
    const uniform = [
      makeResult('u1', 0.7, ['a']),
      makeResult('u2', 0.7, ['b']),
      makeResult('u3', 0.7, ['a']),
    ];
    const out = mmrRerank(uniform, { lambda: 0.5, k: 3 });
    expect(out.map((r) => r.id)).toEqual(['u1', 'u2', 'u3']);
  });
});

describe('mmrRerank — k<=1 first-pick is argmax, not index 0 (PR #228 finding 5)', () => {
  it('k=1 on an UNSORTED pool returns the max-score candidate', () => {
    // Pool is intentionally not relevance-sorted: the true max is at index 2.
    const unsorted = [
      makeResult('low', 0.10, ['a']),
      makeResult('mid', 0.50, ['b']),
      makeResult('high', 0.95, ['c']),
      makeResult('mid2', 0.40, ['d']),
    ];
    const out = mmrRerank(unsorted, { lambda: 0.5, k: 1 });
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe('high');
  });

  it('k=1 on a sorted pool returns the top candidate', () => {
    const out = mmrRerank(fixtureA, { lambda: 0.5, k: 1 });
    expect(out.map((r) => r.id)).toEqual(['jwt-1']);
  });

  it('k=0 returns []', () => {
    expect(mmrRerank(fixtureA, { lambda: 0.5, k: 0 })).toEqual([]);
  });
});

describe('mmrRerank — custom relevance accessor (consumer composite_score path)', () => {
  it('diversifies on the supplied relevanceOf field, not raw score', () => {
    // Raw `score` ordering would seed with rawHigh; but composite_score (the
    // accessor) makes compHigh the most relevant → it must be the first pick.
    type WithComposite = SearchResult & { composite_score: number };
    const rows: WithComposite[] = [
      { ...makeResult('rawHigh', 0.99, ['jwt']), composite_score: 0.20 },
      { ...makeResult('compHigh', 0.10, ['jwt']), composite_score: 0.99 },
      { ...makeResult('div', 0.50, ['rls']), composite_score: 0.50 },
    ];
    const out = mmrRerank(rows, {
      lambda: 0.5,
      k: 2,
      relevanceOf: (r) => r.composite_score,
    });
    expect(out[0].id).toBe('compHigh');
    // Second pick should be the diverse 'rls' row, not the near-duplicate jwt.
    expect(out[1].id).toBe('div');
  });
});

describe('mmrRerank — US2 relevance never sacrificed (FR-004/005)', () => {
  it('SC-003: first selected result is always the max-score candidate (λ=0.5)', () => {
    const out = mmrRerank(fixtureA, { lambda: 0.5, k: 5 });
    expect(out[0].id).toBe('jwt-1');
  });

  it('SC-003: first pick is max relevance even at λ=0.0 (pure diversity)', () => {
    const out = mmrRerank(fixtureA, { lambda: 0.0, k: 5 });
    expect(out[0].id).toBe('jwt-1');
  });

  it('FR-005 / SC-002: λ=1.0 reproduces the relevance ordering exactly', () => {
    const k = 5;
    const expected = [...fixtureA]
      .sort((a, b) => b.score - a.score)
      .slice(0, k)
      .map((r) => r.id);
    const out = mmrRerank(fixtureA, { lambda: 1.0, k });
    expect(out.map((r) => r.id)).toEqual(expected);
  });

  it('default λ (0.5) when lambda omitted still diversifies and seeds with max relevance', () => {
    const out = mmrRerank(fixtureA, { k: 5 });
    expect(out[0].id).toBe('jwt-1');
    expect(distinctTags(out).size).toBeGreaterThanOrEqual(3);
  });
});
