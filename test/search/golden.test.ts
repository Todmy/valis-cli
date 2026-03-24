/**
 * Golden test scaffold for reranking quality evaluation.
 *
 * This file provides the structure for evaluating multi-signal reranking
 * against known-good query-result orderings using NDCG@10.
 *
 * TODO (T078): Populate with 50 query-result pairs and expected orderings.
 *
 * @phase 003-search-growth (T010 scaffold, T078 full implementation)
 */

import { describe, it, expect } from 'vitest';
import { rerank } from '../../src/search/reranker.js';
import type { SearchResult } from '../../src/types.js';

// ---------------------------------------------------------------------------
// NDCG@K helper
// ---------------------------------------------------------------------------

/**
 * Compute Normalized Discounted Cumulative Gain at position K.
 *
 * @param predicted  Ordered list of result IDs (predicted ranking).
 * @param relevance  Map of result ID -> relevance score (higher = better).
 * @param k  Number of top results to evaluate.
 * @returns NDCG@K score in [0, 1].
 */
function ndcgAtK(
  predicted: string[],
  relevance: Map<string, number>,
  k: number,
): number {
  const dcg = computeDCG(predicted.slice(0, k), relevance);
  // Ideal ordering: sort by relevance descending
  const idealOrder = [...relevance.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([id]) => id);
  const idcg = computeDCG(idealOrder.slice(0, k), relevance);

  if (idcg === 0) return 0;
  return dcg / idcg;
}

function computeDCG(
  ranking: string[],
  relevance: Map<string, number>,
): number {
  let dcg = 0;
  for (let i = 0; i < ranking.length; i++) {
    const rel = relevance.get(ranking[i]) ?? 0;
    dcg += (Math.pow(2, rel) - 1) / Math.log2(i + 2); // i+2 because log2(1)=0
  }
  return dcg;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeResult(overrides: Partial<SearchResult> = {}): SearchResult {
  return {
    id: overrides.id ?? 'r1',
    score: overrides.score ?? 0.5,
    type: overrides.type ?? 'decision',
    summary: overrides.summary ?? 'test',
    detail: overrides.detail ?? 'test detail',
    author: overrides.author ?? 'alice',
    affects: overrides.affects ?? ['auth'],
    created_at: overrides.created_at ?? new Date().toISOString(),
    status: overrides.status ?? 'active',
    confidence: overrides.confidence ?? 0.5,
    pinned: overrides.pinned ?? false,
    depends_on: overrides.depends_on ?? [],
  };
}

// ---------------------------------------------------------------------------
// Golden test scaffold
// ---------------------------------------------------------------------------

describe('Golden test: reranking quality', () => {
  it('NDCG helper computes correctly for perfect ordering', () => {
    const relevance = new Map([
      ['a', 3],
      ['b', 2],
      ['c', 1],
    ]);
    const ndcg = ndcgAtK(['a', 'b', 'c'], relevance, 3);
    expect(ndcg).toBeCloseTo(1.0, 5);
  });

  it('NDCG helper penalizes reversed ordering', () => {
    const relevance = new Map([
      ['a', 3],
      ['b', 2],
      ['c', 1],
    ]);
    const ndcg = ndcgAtK(['c', 'b', 'a'], relevance, 3);
    expect(ndcg).toBeLessThan(1.0);
    expect(ndcg).toBeGreaterThan(0);
  });

  it('scaffold: reranker produces stable ordering for sample data', () => {
    const now = Date.now();
    const results: SearchResult[] = [
      makeResult({
        id: 'recent-high',
        score: 0.85,
        confidence: 0.9,
        created_at: new Date(now - 1 * 86_400_000).toISOString(),
      }),
      makeResult({
        id: 'old-pinned',
        score: 0.70,
        confidence: 0.8,
        pinned: true,
        created_at: new Date(now - 180 * 86_400_000).toISOString(),
      }),
      makeResult({
        id: 'old-low',
        score: 0.60,
        confidence: 0.3,
        created_at: new Date(now - 200 * 86_400_000).toISOString(),
      }),
    ];

    const reranked = rerank(results, undefined, now);
    expect(reranked.length).toBe(3);
    // Verify ordering is deterministic
    const ids = reranked.map((r) => r.id);
    const reranked2 = rerank(results, undefined, now);
    expect(reranked2.map((r) => r.id)).toEqual(ids);
  });

  it('performance: reranks 50 results in <10ms', () => {
    const now = Date.now();
    const results: SearchResult[] = Array.from({ length: 50 }, (_, i) =>
      makeResult({
        id: `r${i}`,
        score: Math.random(),
        confidence: Math.random(),
        created_at: new Date(now - Math.random() * 365 * 86_400_000).toISOString(),
        pinned: i % 10 === 0,
        depends_on: i > 0 ? [`r${i - 1}`] : [],
        affects: [`area-${i % 5}`],
      }),
    );

    const start = performance.now();
    const reranked = rerank(results, undefined, now);
    const elapsed = performance.now() - start;

    expect(reranked.length).toBe(50);
    expect(elapsed).toBeLessThan(10); // <10ms budget
  });

  // TODO (T078): Add 50 query-result pairs with human-ranked expected orderings
  // and measure NDCG@10 improvement over single-signal baseline.
  it.todo('golden set: NDCG@10 improvement over single-signal baseline');
});
