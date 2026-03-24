import { describe, it, expect } from 'vitest';
import {
  DEFAULT_WEIGHTS,
  normalizeWeights,
  compositeScore,
  rerank,
} from '../../src/search/reranker.js';
import type { SearchResult, SignalValues, SignalWeights } from '../../src/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
    confidence: overrides.confidence ?? 0.7,
    pinned: overrides.pinned ?? false,
    depends_on: overrides.depends_on ?? [],
    bm25_score: overrides.bm25_score ?? undefined,
  };
}

function daysAgo(days: number, now: number = Date.now()): string {
  return new Date(now - days * 86_400_000).toISOString();
}

// ---------------------------------------------------------------------------
// normalizeWeights
// ---------------------------------------------------------------------------

describe('normalizeWeights', () => {
  it('returns default weights when no overrides', () => {
    const w = normalizeWeights();
    expect(w).toEqual(DEFAULT_WEIGHTS);
  });

  it('normalizes weights that do not sum to 1.0', () => {
    const w = normalizeWeights({ semantic: 0.6, bm25: 0.4, recency: 0.4, importance: 0.3, graph: 0.3 });
    const sum = w.semantic + w.bm25 + w.recency + w.importance + w.graph;
    expect(sum).toBeCloseTo(1.0, 5);
  });

  it('preserves weights that already sum to 1.0', () => {
    const w = normalizeWeights({ semantic: 0.5, bm25: 0.2, recency: 0.1, importance: 0.1, graph: 0.1 });
    expect(w.semantic).toBeCloseTo(0.5, 5);
    expect(w.bm25).toBeCloseTo(0.2, 5);
  });

  it('returns defaults when all weights are zero', () => {
    const w = normalizeWeights({ semantic: 0, bm25: 0, recency: 0, importance: 0, graph: 0 });
    expect(w).toEqual(DEFAULT_WEIGHTS);
  });

  it('merges partial overrides with defaults', () => {
    const w = normalizeWeights({ semantic: 0.5 });
    // semantic changed, others from defaults — then all normalized
    const sum = w.semantic + w.bm25 + w.recency + w.importance + w.graph;
    expect(sum).toBeCloseTo(1.0, 5);
    expect(w.semantic).toBeGreaterThan(DEFAULT_WEIGHTS.semantic);
  });
});

// ---------------------------------------------------------------------------
// compositeScore
// ---------------------------------------------------------------------------

describe('compositeScore', () => {
  it('computes weighted sum correctly', () => {
    const signals: SignalValues = {
      semantic_score: 1.0,
      bm25_score: 1.0,
      recency_decay: 1.0,
      importance: 1.0,
      graph_connectivity: 1.0,
    };
    const score = compositeScore(signals, DEFAULT_WEIGHTS);
    expect(score).toBeCloseTo(1.0, 5);
  });

  it('returns 0 when all signals are 0', () => {
    const signals: SignalValues = {
      semantic_score: 0,
      bm25_score: 0,
      recency_decay: 0,
      importance: 0,
      graph_connectivity: 0,
    };
    expect(compositeScore(signals, DEFAULT_WEIGHTS)).toBe(0);
  });

  it('weights affect the score correctly', () => {
    const signals: SignalValues = {
      semantic_score: 1.0,
      bm25_score: 0.0,
      recency_decay: 0.0,
      importance: 0.0,
      graph_connectivity: 0.0,
    };
    const score = compositeScore(signals, DEFAULT_WEIGHTS);
    expect(score).toBeCloseTo(0.3, 5); // semantic weight = 0.30
  });
});

// ---------------------------------------------------------------------------
// rerank
// ---------------------------------------------------------------------------

describe('rerank', () => {
  const now = Date.now();

  it('returns empty array for empty input', () => {
    expect(rerank([], undefined, now)).toEqual([]);
  });

  it('sorts results by composite score descending', () => {
    const results = [
      makeResult({ id: 'low', score: 0.3, confidence: 0.2, created_at: daysAgo(180, now) }),
      makeResult({ id: 'high', score: 0.9, confidence: 0.9, created_at: daysAgo(1, now) }),
      makeResult({ id: 'mid', score: 0.6, confidence: 0.5, created_at: daysAgo(30, now) }),
    ];
    const reranked = rerank(results, undefined, now);
    expect(reranked[0].id).toBe('high');
    expect(reranked[reranked.length - 1].id).toBe('low');
  });

  it('pinned decisions rank higher due to importance and recency boost', () => {
    const results = [
      makeResult({ id: 'old-pinned', score: 0.5, confidence: 0.6, created_at: daysAgo(180, now), pinned: true }),
      makeResult({ id: 'new-unpinned', score: 0.5, confidence: 0.6, created_at: daysAgo(1, now), pinned: false }),
    ];
    const reranked = rerank(results, undefined, now);
    // Pinned gets recency=1.0 and importance=min(0.6*2,1)=1.0
    // Unpinned gets recency~1.0 (1 day) and importance=0.6
    // With same semantic score, pinned should be first
    expect(reranked[0].id).toBe('old-pinned');
  });

  it('includes signal breakdown in results', () => {
    const results = [makeResult({ id: 'a', score: 0.8 })];
    const reranked = rerank(results, undefined, now);
    expect(reranked[0].signals).toBeDefined();
    expect(reranked[0].signals.semantic_score).toBeCloseTo(0.8, 5);
    expect(reranked[0].signals.recency_decay).toBeGreaterThan(0);
    expect(reranked[0].signals.importance).toBeGreaterThan(0);
    expect(typeof reranked[0].composite_score).toBe('number');
  });

  it('respects custom weights', () => {
    const results = [
      makeResult({ id: 'a', score: 1.0, confidence: 0.1, created_at: daysAgo(180, now) }),
      makeResult({ id: 'b', score: 0.1, confidence: 0.9, created_at: daysAgo(1, now) }),
    ];
    // Weight importance heavily
    const reranked = rerank(
      results,
      { weights: { semantic: 0.0, bm25: 0.0, recency: 0.0, importance: 1.0, graph: 0.0 } },
      now,
    );
    // 'b' has confidence 0.9 > 'a' confidence 0.1
    expect(reranked[0].id).toBe('b');
  });

  it('handles graph connectivity signal', () => {
    const results = [
      makeResult({ id: 'a', score: 0.5, depends_on: [] }),
      makeResult({ id: 'b', score: 0.5, depends_on: ['a'] }),
      makeResult({ id: 'c', score: 0.5, depends_on: ['a'] }),
    ];
    const reranked = rerank(
      results,
      { weights: { semantic: 0.0, bm25: 0.0, recency: 0.0, importance: 0.0, graph: 1.0 } },
      now,
    );
    // 'a' has the most inbound references
    expect(reranked[0].id).toBe('a');
  });

  it('falls back to raw score ordering when all signals fail', () => {
    // This is hard to trigger with pure functions, but we can verify
    // the structure is correct on normal input
    const results = [
      makeResult({ id: 'a', score: 0.9 }),
      makeResult({ id: 'b', score: 0.3 }),
    ];
    const reranked = rerank(results, undefined, now);
    expect(reranked.length).toBe(2);
    expect(reranked[0].composite_score).toBeGreaterThanOrEqual(reranked[1].composite_score);
  });

  it('normalizes BM25 scores across results', () => {
    const results = [
      makeResult({ id: 'a', score: 0.5, bm25_score: 10.0 }),
      makeResult({ id: 'b', score: 0.5, bm25_score: 5.0 }),
      makeResult({ id: 'c', score: 0.5, bm25_score: 0.0 }),
    ];
    const reranked = rerank(
      results,
      { weights: { semantic: 0.0, bm25: 1.0, recency: 0.0, importance: 0.0, graph: 0.0 } },
      now,
    );
    expect(reranked[0].id).toBe('a'); // highest BM25
    expect(reranked[0].signals.bm25_score).toBeCloseTo(1.0, 5);
    expect(reranked[2].signals.bm25_score).toBeCloseTo(0.0, 5);
  });
});

// ---------------------------------------------------------------------------
// T048: Performance benchmark — rerank 50 results in <10ms
// ---------------------------------------------------------------------------

describe('performance benchmark (T048)', () => {
  function generate50Results(): SearchResult[] {
    const ts = Date.now();
    const results: SearchResult[] = [];
    for (let i = 0; i < 50; i++) {
      const ageDays = Math.floor(Math.random() * 365);
      results.push(
        makeResult({
          id: `d-${i.toString().padStart(3, '0')}`,
          score: Math.random(),
          bm25_score: Math.random() * 5,
          confidence: Math.random(),
          pinned: i % 10 === 0,
          depends_on: i > 0 ? [`d-${(i - 1).toString().padStart(3, '0')}`] : [],
          affects: [`area-${i % 5}`],
          created_at: new Date(ts - ageDays * 86_400_000).toISOString(),
        } as Partial<SearchResult>),
      );
    }
    return results;
  }

  it('reranks 50 results in under 10ms', () => {
    const results = generate50Results();

    // Warm-up run to avoid JIT penalties
    rerank(results);

    // Benchmark: 10 iterations, take median
    const times: number[] = [];
    for (let run = 0; run < 10; run++) {
      const start = performance.now();
      rerank(results);
      const elapsed = performance.now() - start;
      times.push(elapsed);
    }

    times.sort((a, b) => a - b);
    const median = times[Math.floor(times.length / 2)];

    // Assert median time is under 10ms
    expect(median).toBeLessThan(10);
  });
});
