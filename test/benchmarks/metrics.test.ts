/**
 * 021/T006: tabular tests for pure-function retrieval metrics.
 *
 * Test the contract documented in `specs/021-public-benchmarks/data-model.md`
 * §"Metrics module interfaces" — empty hits, partial hits, all-correct,
 * all-wrong, k=1, k > hits.length, ties in score.
 */

import { describe, it, expect } from 'vitest';
import { recallAtK, mrr, ndcgAtK } from '../../src/benchmarks/metrics.js';
import type { GroundTruth, SearchHit } from '../../src/benchmarks/types.js';

function hit(doc_id: string, rank: number, score = 1 / rank): SearchHit {
  return { doc_id, rank, score };
}

function gt(query_id: string, relevant: string[]): GroundTruth {
  return { query_id, relevant_doc_ids: relevant };
}

// ---------------------------------------------------------------------------
// recallAtK
// ---------------------------------------------------------------------------

describe('recallAtK', () => {
  it('returns 1 when every query has a relevant hit in top-k', () => {
    const score = recallAtK(
      [
        { hits: [hit('a', 1), hit('b', 2)], groundTruth: gt('q1', ['a']) },
        { hits: [hit('c', 1)], groundTruth: gt('q2', ['c']) },
      ],
      5,
    );
    expect(score).toBe(1);
  });

  it('returns 0 when no query has any relevant hit in top-k', () => {
    const score = recallAtK(
      [
        { hits: [hit('a', 1)], groundTruth: gt('q1', ['z']) },
        { hits: [hit('b', 1)], groundTruth: gt('q2', ['y']) },
      ],
      5,
    );
    expect(score).toBe(0);
  });

  it('returns 0.5 when half the queries hit', () => {
    const score = recallAtK(
      [
        { hits: [hit('a', 1)], groundTruth: gt('q1', ['a']) },
        { hits: [hit('b', 1)], groundTruth: gt('q2', ['z']) },
      ],
      5,
    );
    expect(score).toBe(0.5);
  });

  it('only counts hits within k (k=1 ignores rank 2+)', () => {
    const score = recallAtK(
      [{ hits: [hit('a', 1), hit('b', 2)], groundTruth: gt('q1', ['b']) }],
      1,
    );
    expect(score).toBe(0);
  });

  it('handles k larger than hits.length without throwing', () => {
    const score = recallAtK(
      [{ hits: [hit('a', 1)], groundTruth: gt('q1', ['a']) }],
      10,
    );
    expect(score).toBe(1);
  });

  it('handles empty hits arrays — counts as a miss', () => {
    const score = recallAtK(
      [
        { hits: [], groundTruth: gt('q1', ['a']) },
        { hits: [hit('b', 1)], groundTruth: gt('q2', ['b']) },
      ],
      5,
    );
    expect(score).toBe(0.5);
  });

  it('throws when k < 1', () => {
    expect(() =>
      recallAtK([{ hits: [hit('a', 1)], groundTruth: gt('q1', ['a']) }], 0),
    ).toThrow();
  });

  it('throws when results is empty', () => {
    expect(() => recallAtK([], 5)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// mrr
// ---------------------------------------------------------------------------

describe('mrr', () => {
  it('returns 1 when every query has rank-1 relevant hit', () => {
    const score = mrr([
      { hits: [hit('a', 1)], groundTruth: gt('q1', ['a']) },
      { hits: [hit('b', 1)], groundTruth: gt('q2', ['b']) },
    ]);
    expect(score).toBe(1);
  });

  it('returns 0.5 when first relevant is at rank 2', () => {
    const score = mrr([
      { hits: [hit('x', 1), hit('a', 2)], groundTruth: gt('q1', ['a']) },
    ]);
    expect(score).toBe(0.5);
  });

  it('averages reciprocal ranks across queries', () => {
    const score = mrr([
      { hits: [hit('a', 1)], groundTruth: gt('q1', ['a']) },
      { hits: [hit('x', 1), hit('y', 2), hit('b', 3)], groundTruth: gt('q2', ['b']) },
    ]);
    expect(score).toBeCloseTo((1 + 1 / 3) / 2, 6);
  });

  it('treats no-relevant-hit as 0 for that query', () => {
    const score = mrr([
      { hits: [hit('x', 1)], groundTruth: gt('q1', ['a']) },
      { hits: [hit('b', 1)], groundTruth: gt('q2', ['b']) },
    ]);
    expect(score).toBe(0.5);
  });

  it('handles empty hits — counts as 0 for that query', () => {
    const score = mrr([
      { hits: [], groundTruth: gt('q1', ['a']) },
    ]);
    expect(score).toBe(0);
  });

  it('throws when results is empty', () => {
    expect(() => mrr([])).toThrow();
  });
});

// ---------------------------------------------------------------------------
// ndcgAtK
// ---------------------------------------------------------------------------

describe('ndcgAtK', () => {
  it('returns 1 when relevant doc is at rank 1 (perfect ordering)', () => {
    const score = ndcgAtK(
      [{ hits: [hit('a', 1), hit('x', 2)], groundTruth: gt('q1', ['a']) }],
      10,
    );
    expect(score).toBe(1);
  });

  it('returns 0 when no relevant doc appears in top-k', () => {
    const score = ndcgAtK(
      [{ hits: [hit('x', 1), hit('y', 2)], groundTruth: gt('q1', ['a']) }],
      10,
    );
    expect(score).toBe(0);
  });

  it('returns 0 by convention when ground truth is empty for a query (no relevant docs)', () => {
    const score = ndcgAtK(
      [{ hits: [hit('a', 1)], groundTruth: gt('q1', []) as unknown as GroundTruth }],
      10,
    );
    expect(score).toBe(0);
  });

  it('produces value in (0, 1) when relevant doc is not at top rank', () => {
    const score = ndcgAtK(
      [{ hits: [hit('x', 1), hit('a', 2)], groundTruth: gt('q1', ['a']) }],
      10,
    );
    // DCG = 1/log2(3) ≈ 0.6309
    // IDCG = 1/log2(2) = 1
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(1);
    expect(score).toBeCloseTo(1 / Math.log2(3), 4);
  });

  it('IDCG cap accounts for multiple relevant docs', () => {
    // 2 relevant docs perfectly ranked → ideal DCG = 1/log2(2) + 1/log2(3)
    const score = ndcgAtK(
      [{ hits: [hit('a', 1), hit('b', 2), hit('x', 3)], groundTruth: gt('q1', ['a', 'b']) }],
      10,
    );
    expect(score).toBe(1);
  });

  it('truncates hits beyond k', () => {
    const score = ndcgAtK(
      [{ hits: [hit('x', 1), hit('y', 2), hit('a', 3)], groundTruth: gt('q1', ['a']) }],
      2,
    );
    expect(score).toBe(0);
  });

  it('returns value in [0, 1] across averaged queries', () => {
    const score = ndcgAtK(
      [
        { hits: [hit('a', 1)], groundTruth: gt('q1', ['a']) },
        { hits: [hit('x', 1)], groundTruth: gt('q2', ['y']) },
      ],
      10,
    );
    expect(score).toBe(0.5);
  });

  it('throws when k < 1', () => {
    expect(() =>
      ndcgAtK([{ hits: [hit('a', 1)], groundTruth: gt('q1', ['a']) }], 0),
    ).toThrow();
  });

  it('throws when results is empty', () => {
    expect(() => ndcgAtK([], 10)).toThrow();
  });
});
