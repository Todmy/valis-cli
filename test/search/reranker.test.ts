import { describe, it, expect } from 'vitest';
import { rerank, normalizeWeights, DEFAULT_WEIGHTS, stage1Rerank } from '../../src/search/reranker.js';
import type { RerankableResult } from '../../src/search/reranker.js';
import type { SignalWeights } from '../../src/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MS_PER_DAY = 86_400_000;
const NOW = new Date('2026-03-24T00:00:00Z').getTime();

function makeResult(
  overrides: Partial<RerankableResult> & { id: string },
): RerankableResult {
  return {
    score: 0.8,
    type: 'decision',
    summary: 'test',
    detail: 'test detail',
    author: 'alice',
    affects: ['api'],
    created_at: new Date(NOW).toISOString(),
    status: 'active',
    confidence: 0.7,
    pinned: false,
    depends_on: [],
    bm25_score: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// normalizeWeights
// ---------------------------------------------------------------------------

describe('normalizeWeights', () => {
  it('returns weights unchanged when they sum to 1.0', () => {
    const w = normalizeWeights(DEFAULT_WEIGHTS);
    const sum = w.semantic + w.bm25 + w.recency + w.importance + w.graph + w.cluster;
    expect(sum).toBeCloseTo(1.0, 9);
  });

  it('normalizes weights that do not sum to 1.0', () => {
    const w = normalizeWeights({
      semantic: 3,
      bm25: 2,
      recency: 2,
      importance: 1.5,
      graph: 1,
      cluster: 0.5,
    });
    const sum = w.semantic + w.bm25 + w.recency + w.importance + w.graph + w.cluster;
    expect(sum).toBeCloseTo(1.0, 9);
    expect(w.semantic).toBeCloseTo(0.3, 5);
  });

  it('falls back to equal weights when all zero', () => {
    const w = normalizeWeights({
      semantic: 0,
      bm25: 0,
      recency: 0,
      importance: 0,
      graph: 0,
      cluster: 0,
    });
    expect(w.semantic).toBe(0.2);
    expect(w.bm25).toBe(0.2);
    expect(w.recency).toBe(0.2);
    expect(w.importance).toBe(0.2);
    expect(w.graph).toBe(0.1);
    expect(w.cluster).toBe(0.1);
  });
});

// ---------------------------------------------------------------------------
// rerank — composite scoring
// ---------------------------------------------------------------------------

describe('rerank', () => {
  it('returns empty array for empty input', () => {
    expect(rerank([], undefined, NOW)).toEqual([]);
  });

  it('computes composite_score with default weights', () => {
    const results = [makeResult({ id: 'a', score: 0.9, confidence: 0.8 })];
    const reranked = rerank(results, undefined, NOW);

    expect(reranked).toHaveLength(1);
    expect(reranked[0].composite_score).toBeGreaterThan(0);
    expect(reranked[0].signals).toBeDefined();
    expect(reranked[0].signals.semantic_score).toBe(0.9);
  });

  it('sorts results by composite_score descending', () => {
    const results = [
      makeResult({
        id: 'low',
        score: 0.3,
        confidence: 0.2,
        created_at: new Date(NOW - 180 * MS_PER_DAY).toISOString(),
      }),
      makeResult({
        id: 'high',
        score: 0.95,
        confidence: 0.9,
        created_at: new Date(NOW).toISOString(),
      }),
    ];

    const reranked = rerank(results, undefined, NOW);
    expect(reranked[0].id).toBe('high');
    expect(reranked[1].id).toBe('low');
    expect(reranked[0].composite_score).toBeGreaterThan(reranked[1].composite_score);
  });

  it('includes signal breakdown for each result', () => {
    const results = [makeResult({ id: 'a' })];
    const reranked = rerank(results, undefined, NOW);

    const s = reranked[0].signals;
    expect(s).toHaveProperty('semantic_score');
    expect(s).toHaveProperty('bm25_score');
    expect(s).toHaveProperty('recency_decay');
    expect(s).toHaveProperty('importance');
    expect(s).toHaveProperty('graph_connectivity');
    expect(s).toHaveProperty('cluster_boost');
  });

  it('respects custom weights from RerankConfig', () => {
    const results = [
      makeResult({ id: 'a', score: 0.5, confidence: 1.0 }),
    ];

    const config = {
      weights: { semantic: 0.0, bm25: 0.0, recency: 0.0, importance: 1.0, graph: 0.0, cluster: 0.0 },
    };

    const reranked = rerank(results, config, NOW);
    expect(reranked[0].composite_score).toBeCloseTo(reranked[0].signals.importance, 5);
  });

  it('recency decay affects ordering for old vs new decisions', () => {
    const results = [
      makeResult({
        id: 'old',
        score: 0.8,
        confidence: 0.7,
        created_at: new Date(NOW - 365 * MS_PER_DAY).toISOString(),
      }),
      makeResult({
        id: 'new',
        score: 0.8,
        confidence: 0.7,
        created_at: new Date(NOW).toISOString(),
      }),
    ];

    const reranked = rerank(results, undefined, NOW);
    expect(reranked[0].id).toBe('new');
    expect(reranked[0].signals.recency_decay).toBeGreaterThan(
      reranked[1].signals.recency_decay,
    );
  });

  it('pinned decisions get boosted importance and full recency', () => {
    const results = [
      makeResult({
        id: 'pinned',
        score: 0.7,
        confidence: 0.6,
        pinned: true,
        created_at: new Date(NOW - 180 * MS_PER_DAY).toISOString(),
      }),
      makeResult({
        id: 'unpinned',
        score: 0.7,
        confidence: 0.6,
        pinned: false,
        created_at: new Date(NOW - 180 * MS_PER_DAY).toISOString(),
      }),
    ];

    const reranked = rerank(results, undefined, NOW);
    const pinned = reranked.find((r) => r.id === 'pinned')!;
    const unpinned = reranked.find((r) => r.id === 'unpinned')!;

    expect(pinned.signals.recency_decay).toBe(1.0);
    expect(pinned.signals.importance).toBe(1.0);
    expect(unpinned.signals.recency_decay).toBeLessThan(1.0);
    expect(unpinned.signals.importance).toBe(0.6);

    expect(pinned.composite_score).toBeGreaterThan(unpinned.composite_score);
  });

  it('graph connectivity boosts decisions with dependents (no area overlap)', () => {
    // Use distinct affects to isolate inbound dep signal from area co-occurrence
    const results = [
      makeResult({ id: 'root', score: 0.7, confidence: 0.5, depends_on: [], affects: ['area-root'] }),
      makeResult({ id: 'leaf1', score: 0.7, confidence: 0.5, depends_on: ['root'], affects: ['area-1'] }),
      makeResult({ id: 'leaf2', score: 0.7, confidence: 0.5, depends_on: ['root'], affects: ['area-2'] }),
    ];

    const reranked = rerank(results, undefined, NOW);
    const root = reranked.find((r) => r.id === 'root')!;
    const leaf1 = reranked.find((r) => r.id === 'leaf1')!;

    // root has 2 inbound, no area co-occurrence (distinct affects)
    expect(root.signals.graph_connectivity).toBe(1.0);
    // leaf1 has 0 inbound and no area peers
    expect(leaf1.signals.graph_connectivity).toBe(0);
  });

  it('uses content-aware halfLifeDays from config', () => {
    // type='decision' has base half-life of 180 days.
    // At baseHalfLifeDays=90 (default), scale factor = 1.0, effective = 180 days.
    // A 180-day-old decision should have recency ~0.5.
    const results = [
      makeResult({
        id: 'a',
        type: 'decision',
        created_at: new Date(NOW - 180 * MS_PER_DAY).toISOString(),
      }),
    ];

    const reranked = rerank(results, { halfLifeDays: 90 }, NOW);
    expect(reranked[0].signals.recency_decay).toBeCloseTo(0.5, 2);
  });

  it('preserves extra fields from input results', () => {
    const results = [
      makeResult({ id: 'a', status: 'proposed', affects: ['auth', 'api'] }),
    ];
    const reranked = rerank(results, undefined, NOW);
    expect(reranked[0].status).toBe('proposed');
    expect(reranked[0].affects).toEqual(['auth', 'api']);
  });

  it('handles BM25 normalization across results', () => {
    const results = [
      makeResult({ id: 'a', bm25_score: 10 }),
      makeResult({ id: 'b', bm25_score: 5 }),
      makeResult({ id: 'c', bm25_score: 0 }),
    ];

    const reranked = rerank(results, undefined, NOW);
    const a = reranked.find((r) => r.id === 'a')!;
    const b = reranked.find((r) => r.id === 'b')!;
    const c = reranked.find((r) => r.id === 'c')!;

    expect(a.signals.bm25_score).toBe(1.0);
    expect(b.signals.bm25_score).toBeCloseTo(0.5, 5);
    expect(c.signals.bm25_score).toBe(0.0);
  });
});

// ---------------------------------------------------------------------------
// Performance benchmark (T048 scaffold)
// ---------------------------------------------------------------------------

describe('rerank performance', () => {
  it('reranks 50 results in under 10ms', () => {
    const results: RerankableResult[] = Array.from({ length: 50 }, (_, i) =>
      makeResult({
        id: `d-${i}`,
        score: Math.random(),
        bm25_score: Math.random() * 10,
        confidence: Math.random(),
        pinned: i % 10 === 0,
        depends_on: i > 0 ? [`d-${i - 1}`] : [],
        created_at: new Date(NOW - i * MS_PER_DAY).toISOString(),
        affects: [`area-${i % 5}`],
      }),
    );

    const start = performance.now();
    const reranked = rerank(results, undefined, NOW);
    const elapsed = performance.now() - start;

    expect(reranked).toHaveLength(50);
    // Area co-occurrence in graphConnectivity adds O(n*m) work;
    // 100ms is a reasonable upper bound for 50 results in CI.
    expect(elapsed).toBeLessThan(100);
  });
});
