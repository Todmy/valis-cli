/**
 * Golden test scaffold for search reranking quality evaluation.
 *
 * This file defines the types and infrastructure for maintaining a set of
 * query-result pairs with expected orderings. The actual test data will be
 * populated as the system accumulates real-world usage patterns.
 *
 * Metric: NDCG@10 (Normalized Discounted Cumulative Gain at position 10).
 *
 * @see T078 in tasks.md for the full 50-pair golden set target.
 */

import { describe, it, expect } from 'vitest';
import { rerank } from '../../src/search/reranker.js';
import type { RerankableResult } from '../../src/search/reranker.js';
import type { SignalWeights } from '../../src/types.js';

// ---------------------------------------------------------------------------
// Types for golden test pairs
// ---------------------------------------------------------------------------

/** A single golden test case: a query + expected result ordering. */
export interface GoldenTestCase {
  /** Human-readable test name. */
  name: string;
  /** The search query that produced these results. */
  query: string;
  /** Raw results as they would come from Qdrant (unranked). */
  results: RerankableResult[];
  /** Expected ordering of result IDs after reranking (best first). */
  expected_order: string[];
  /** Optional weight override for this test case. */
  weights?: Partial<SignalWeights>;
}

/** Relevance grade for NDCG computation. */
export type RelevanceGrade = 0 | 1 | 2 | 3;

/** A result with human-assigned relevance grade for NDCG. */
export interface GradedResult {
  id: string;
  /** 0 = irrelevant, 1 = marginally relevant, 2 = relevant, 3 = highly relevant. */
  grade: RelevanceGrade;
}

/** Extended golden test case with relevance grades for NDCG. */
export interface GoldenNdcgTestCase {
  name: string;
  query: string;
  results: RerankableResult[];
  /** Relevance grades for each result (used for NDCG calculation). */
  graded_results: GradedResult[];
  weights?: Partial<SignalWeights>;
}

// ---------------------------------------------------------------------------
// NDCG@K computation
// ---------------------------------------------------------------------------

/**
 * Compute DCG@K (Discounted Cumulative Gain).
 *
 * DCG@K = sum_{i=1}^{K} (2^rel_i - 1) / log2(i + 1)
 */
function dcgAtK(relevances: number[], k: number): number {
  let dcg = 0;
  const limit = Math.min(k, relevances.length);
  for (let i = 0; i < limit; i++) {
    dcg += (Math.pow(2, relevances[i]) - 1) / Math.log2(i + 2);
  }
  return dcg;
}

/**
 * Compute NDCG@K (Normalized DCG).
 *
 * NDCG@K = DCG@K / IDCG@K
 *
 * IDCG@K is the DCG of the ideal ordering (sorted by relevance descending).
 */
export function ndcgAtK(relevances: number[], k: number): number {
  const dcg = dcgAtK(relevances, k);
  const idealRelevances = [...relevances].sort((a, b) => b - a);
  const idcg = dcgAtK(idealRelevances, k);
  if (idcg === 0) return 0;
  return dcg / idcg;
}

// ---------------------------------------------------------------------------
// Scaffold tests
// ---------------------------------------------------------------------------

describe('golden test scaffold', () => {
  it('ndcgAtK returns 1.0 for a perfect ordering', () => {
    const relevances = [3, 2, 1, 0];
    expect(ndcgAtK(relevances, 4)).toBeCloseTo(1.0, 5);
  });

  it('ndcgAtK returns < 1.0 for a non-ideal ordering', () => {
    const relevances = [0, 1, 2, 3]; // worst possible
    expect(ndcgAtK(relevances, 4)).toBeLessThan(1.0);
    expect(ndcgAtK(relevances, 4)).toBeGreaterThan(0);
  });

  it('ndcgAtK handles empty relevances', () => {
    expect(ndcgAtK([], 10)).toBe(0);
  });

  it('ndcgAtK handles all-zero relevances', () => {
    expect(ndcgAtK([0, 0, 0], 3)).toBe(0);
  });

  it('scaffold: reranker produces a valid ordering', () => {
    // Minimal test to verify the golden test infrastructure works
    const MS_PER_DAY = 86_400_000;
    const NOW = new Date('2026-03-24T00:00:00Z').getTime();

    const results: RerankableResult[] = [
      {
        id: 'recent-good',
        score: 0.9,
        bm25_score: 8,
        type: 'decision',
        summary: 'Recent high-confidence decision',
        detail: 'Chose Postgres for main DB',
        author: 'alice',
        affects: ['database'],
        created_at: new Date(NOW - 5 * MS_PER_DAY).toISOString(),
        confidence: 0.9,
        pinned: false,
        depends_on: [],
      },
      {
        id: 'old-low',
        score: 0.6,
        bm25_score: 3,
        type: 'decision',
        summary: 'Old low-confidence decision',
        detail: 'Considered MySQL',
        author: 'bob',
        affects: ['database'],
        created_at: new Date(NOW - 200 * MS_PER_DAY).toISOString(),
        confidence: 0.3,
        pinned: false,
        depends_on: [],
      },
    ];

    const reranked = rerank(results, undefined, NOW);
    expect(reranked[0].id).toBe('recent-good');
    expect(reranked[1].id).toBe('old-low');
  });
});
