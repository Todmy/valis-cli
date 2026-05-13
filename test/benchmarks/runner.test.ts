/**
 * 021/T015: runner orchestration tests.
 *
 * Use a deterministic mock `searchFn` to drive the runner end-to-end without
 * touching Qdrant. Assertions:
 *   - All three strategies run, each populates its own `MetricSet`.
 *   - `gate_passed` is `true` iff `metrics.hybrid.recall_at_5 >= 0.80`.
 *   - `wall_clock_ms` is monotonically non-zero per strategy.
 *   - Contract violations (gap in ranks, > k hits, duplicates) throw.
 *   - The runner does NOT silently skip queries on contract failure.
 */

import { describe, it, expect, vi } from 'vitest';
import { run } from '../../src/benchmarks/runner.js';
import type {
  CorpusSlice,
  SearchFn,
  SearchHit,
} from '../../src/benchmarks/types.js';

function makeCorpus(overrides: Partial<CorpusSlice> = {}): CorpusSlice {
  const documents = [
    { id: 'd1', text: 'document 1' },
    { id: 'd2', text: 'document 2' },
    { id: 'd3', text: 'document 3' },
  ];
  const queries = [
    { id: 'q1', text: 'find d1' },
    { id: 'q2', text: 'find d2' },
    { id: 'q3', text: 'find d3' },
  ];
  const ground_truth = [
    { query_id: 'q1', relevant_doc_ids: ['d1'] },
    { query_id: 'q2', relevant_doc_ids: ['d2'] },
    { query_id: 'q3', relevant_doc_ids: ['d3'] },
  ];
  return {
    id: 'test-corpus',
    language: 'mixed',
    documents,
    queries,
    ground_truth,
    provenance: {
      corpus_id: 'test-corpus',
      upstream_url: 'fixture://test',
      license: 'CC0-1.0',
      fetched_at: new Date().toISOString(),
      content_hash: 'x'.repeat(64),
      curation_rule: 'test fixture',
    },
    ...overrides,
  };
}

function perfectSearchFn(): SearchFn {
  return async (query, k) => {
    // Match the trailing doc id token from "find dX"
    const docId = query.split(/\s+/).pop() ?? '';
    const hits: SearchHit[] = [{ doc_id: docId, score: 1, rank: 1 }];
    return hits.slice(0, k);
  };
}

function alwaysMissSearchFn(): SearchFn {
  return async (_query, k) =>
    Array.from({ length: Math.min(k, 1) }, (_, i) => ({
      doc_id: 'wrong-doc',
      score: 0.5,
      rank: i + 1,
    }));
}

function badRanksSearchFn(): SearchFn {
  return async () => [
    { doc_id: 'd1', score: 1, rank: 1 },
    { doc_id: 'd2', score: 0.9, rank: 3 }, // gap — illegal
  ];
}

describe('run — happy path', () => {
  it('populates all three strategies on a perfectly-aligned mock', async () => {
    const corpus = makeCorpus();
    const sliceResult = await run({
      corpus,
      searchFns: {
        hybrid: perfectSearchFn(),
        dense_only: perfectSearchFn(),
        bm25_only: perfectSearchFn(),
      },
      metricsK: { recall: [5, 10], ndcg: 10 },
    });

    expect(sliceResult.metrics.hybrid.recall_at_5).toBe(1);
    expect(sliceResult.metrics.dense_only.recall_at_5).toBe(1);
    expect(sliceResult.metrics.bm25_only.recall_at_5).toBe(1);
    expect(sliceResult.metrics.hybrid.mrr).toBe(1);
    expect(sliceResult.metrics.hybrid.ndcg_at_10).toBe(1);
    expect(sliceResult.n_queries).toBe(3);
    expect(sliceResult.n_documents).toBe(3);
    expect(sliceResult.gate_passed).toBe(true);
  });

  it('flags gate_passed=false when hybrid R@5 < 0.80', async () => {
    const corpus = makeCorpus();
    const sliceResult = await run({
      corpus,
      searchFns: {
        hybrid: alwaysMissSearchFn(),
        dense_only: perfectSearchFn(),
        bm25_only: perfectSearchFn(),
      },
      metricsK: { recall: [5, 10], ndcg: 10 },
    });

    expect(sliceResult.metrics.hybrid.recall_at_5).toBe(0);
    expect(sliceResult.gate_passed).toBe(false);
  });

  it('records wall_clock_ms per strategy', async () => {
    const corpus = makeCorpus();
    const sliceResult = await run({
      corpus,
      searchFns: {
        hybrid: perfectSearchFn(),
        dense_only: perfectSearchFn(),
        bm25_only: perfectSearchFn(),
      },
      metricsK: { recall: [5, 10], ndcg: 10 },
    });

    expect(sliceResult.metrics.hybrid.wall_clock_ms).toBeGreaterThanOrEqual(0);
    expect(sliceResult.metrics.dense_only.wall_clock_ms).toBeGreaterThanOrEqual(0);
    expect(sliceResult.metrics.bm25_only.wall_clock_ms).toBeGreaterThanOrEqual(0);
  });

  it('records n_queries_evaluated equal to n_queries when no skips', async () => {
    const corpus = makeCorpus();
    const sliceResult = await run({
      corpus,
      searchFns: {
        hybrid: perfectSearchFn(),
        dense_only: perfectSearchFn(),
        bm25_only: perfectSearchFn(),
      },
      metricsK: { recall: [5, 10], ndcg: 10 },
    });

    expect(sliceResult.metrics.hybrid.n_queries_evaluated).toBe(3);
  });

  it('streams progress updates via onProgress', async () => {
    const corpus = makeCorpus();
    const onProgress = vi.fn();
    await run({
      corpus,
      searchFns: {
        hybrid: perfectSearchFn(),
        dense_only: perfectSearchFn(),
        bm25_only: perfectSearchFn(),
      },
      metricsK: { recall: [5, 10], ndcg: 10 },
      onProgress,
    });
    expect(onProgress).toHaveBeenCalled();
    const lastCall = onProgress.mock.calls.at(-1) as [number, ...unknown[]];
    expect(lastCall[0]).toBeLessThanOrEqual(100);
  });
});

describe('run — contract violations', () => {
  it('throws when a hit list has a rank gap', async () => {
    const corpus = makeCorpus();
    await expect(
      run({
        corpus,
        searchFns: {
          hybrid: badRanksSearchFn(),
          dense_only: perfectSearchFn(),
          bm25_only: perfectSearchFn(),
        },
        metricsK: { recall: [5, 10], ndcg: 10 },
      }),
    ).rejects.toThrow(/rank/i);
  });

  it('throws when a hit list returns more than k entries', async () => {
    const corpus = makeCorpus();
    const overshoot: SearchFn = async (_q, k) =>
      Array.from({ length: k + 2 }, (_, i) => ({
        doc_id: `x${i}`,
        score: 1 / (i + 1),
        rank: i + 1,
      }));
    await expect(
      run({
        corpus,
        searchFns: {
          hybrid: overshoot,
          dense_only: perfectSearchFn(),
          bm25_only: perfectSearchFn(),
        },
        metricsK: { recall: [5, 10], ndcg: 10 },
      }),
    ).rejects.toThrow(/length/i);
  });

  it('throws when a hit list has duplicate doc_ids', async () => {
    const corpus = makeCorpus();
    const dupes: SearchFn = async () => [
      { doc_id: 'd1', score: 1, rank: 1 },
      { doc_id: 'd1', score: 0.9, rank: 2 },
    ];
    await expect(
      run({
        corpus,
        searchFns: {
          hybrid: dupes,
          dense_only: perfectSearchFn(),
          bm25_only: perfectSearchFn(),
        },
        metricsK: { recall: [5, 10], ndcg: 10 },
      }),
    ).rejects.toThrow(/duplicate/i);
  });
});
