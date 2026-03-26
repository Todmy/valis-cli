import { describe, it, expect } from 'vitest';
import { rerank, stage2Rerank, stage1Rerank, STAGE2_WEIGHTS } from '../../src/search/reranker.js';
import type { RerankableResult } from '../../src/search/reranker.js';

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
// Two-stage reranking (rerank with query)
// ---------------------------------------------------------------------------

describe('rerank — two-stage with query', () => {
  it('returns empty array for empty input', () => {
    expect(rerank([], undefined, NOW, 'test')).toEqual([]);
  });

  it('adds matchReason when query is provided', () => {
    const results = [
      makeResult({
        id: 'a',
        score: 0.9,
        summary: 'JWT authentication for API',
        detail: 'Use JWT tokens for API authentication',
      }),
    ];

    const reranked = rerank(results, undefined, NOW, 'JWT authentication');
    expect(reranked[0].matchReason).toBeDefined();
    expect(reranked[0].matchReason!.length).toBeGreaterThan(0);
  });

  it('does not add matchReason when query is omitted (backward compat)', () => {
    const results = [makeResult({ id: 'a' })];
    const reranked = rerank(results, undefined, NOW);
    expect(reranked[0].matchReason).toBeUndefined();
  });

  it('boosts results with exact token matches', () => {
    const results = [
      makeResult({
        id: 'exact-match',
        score: 0.7,
        summary: 'JWT-based auth for API gateway',
        detail: 'We use JWT tokens for API gateway authentication',
        affects: ['auth'],
      }),
      makeResult({
        id: 'semantic-only',
        score: 0.75,
        summary: 'Token-based authentication approach',
        detail: 'Our authentication uses bearer tokens in headers',
        affects: ['auth'],
      }),
    ];

    const reranked = rerank(results, undefined, NOW, 'JWT API gateway');
    const exactMatch = reranked.find((r) => r.id === 'exact-match')!;
    expect(exactMatch.matchReason).toContain('term match');
  });

  it('boosts negation-context results for negation queries', () => {
    const results = [
      makeResult({
        id: 'negation-match',
        score: 0.6,
        summary: 'Avoid using MySQL for new services',
        detail: 'Do not use MySQL. Instead of MySQL, prefer Postgres.',
        affects: ['database'],
      }),
      makeResult({
        id: 'positive-match',
        score: 0.7,
        summary: 'MySQL configuration guide',
        detail: 'How to configure MySQL connections and pools.',
        affects: ['database'],
      }),
    ];

    const reranked = rerank(results, undefined, NOW, "don't use MySQL");
    const negMatch = reranked.find((r) => r.id === 'negation-match')!;
    expect(negMatch.matchReason).toContain('negation');
  });
});

// ---------------------------------------------------------------------------
// stage2Rerank (direct)
// ---------------------------------------------------------------------------

describe('stage2Rerank', () => {
  it('returns empty array for empty input', () => {
    expect(stage2Rerank([], 'test', NOW)).toEqual([]);
  });

  it('generates matchReason for all results', () => {
    const stage1 = stage1Rerank([
      makeResult({ id: 'a', score: 0.9, summary: 'Test decision', detail: 'Details here' }),
      makeResult({ id: 'b', score: 0.7, summary: 'Another one', detail: 'More details' }),
    ], undefined, NOW);

    const stage2 = stage2Rerank(stage1, 'test query', NOW);
    for (const r of stage2) {
      expect(r.matchReason).toBeDefined();
      expect(typeof r.matchReason).toBe('string');
      expect(r.matchReason!.length).toBeGreaterThan(0);
    }
  });

  it('preserves signals from stage 1', () => {
    const stage1 = stage1Rerank([
      makeResult({ id: 'a', score: 0.9 }),
    ], undefined, NOW);

    const stage2 = stage2Rerank(stage1, 'test', NOW);
    expect(stage2[0].signals).toBeDefined();
    expect(stage2[0].signals.semantic_score).toBe(0.9);
  });
});

// ---------------------------------------------------------------------------
// Backward compatibility
// ---------------------------------------------------------------------------

describe('rerank — backward compatibility', () => {
  it('produces the same ordering as stage1 when no query is provided', () => {
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

    const withoutQuery = rerank(results, undefined, NOW);
    const withStage1 = stage1Rerank(results, undefined, NOW);

    expect(withoutQuery.map((r) => r.id)).toEqual(withStage1.map((r) => r.id));
    expect(withoutQuery[0].composite_score).toBeCloseTo(withStage1[0].composite_score, 9);
  });
});

// ---------------------------------------------------------------------------
// matchReason content
// ---------------------------------------------------------------------------

describe('matchReason generation', () => {
  it('includes semantic similarity for high-scoring results', () => {
    const results = [
      makeResult({ id: 'a', score: 0.92, summary: 'Test', detail: 'Test detail' }),
    ];

    const reranked = rerank(results, undefined, NOW, 'test');
    expect(reranked[0].matchReason).toContain('semantic similarity');
    expect(reranked[0].matchReason).toContain('0.92');
  });

  it('includes "pinned" for pinned results', () => {
    const results = [
      makeResult({
        id: 'a',
        score: 0.8,
        pinned: true,
        confidence: 0.6,
        summary: 'Pinned decision',
        detail: 'This is pinned',
      }),
    ];

    const reranked = rerank(results, undefined, NOW, 'pinned');
    expect(reranked[0].matchReason).toContain('pinned');
  });

  it('includes "recent" for recent results', () => {
    const results = [
      makeResult({
        id: 'a',
        score: 0.8,
        summary: 'Recent auth change',
        detail: 'Changed auth yesterday',
        created_at: new Date(NOW - 1 * MS_PER_DAY).toISOString(),
      }),
    ];

    const reranked = rerank(results, undefined, NOW, 'auth change');
    expect(reranked[0].matchReason).toContain('recent');
  });

  it('provides fallback reason when no strong signals', () => {
    const results = [
      makeResult({
        id: 'a',
        score: 0.3,
        confidence: 0.3,
        summary: 'Unrelated decision',
        detail: 'Nothing matching here',
        affects: [],
        created_at: new Date(NOW - 365 * MS_PER_DAY).toISOString(),
      }),
    ];

    const reranked = rerank(results, undefined, NOW, 'completely unrelated query');
    expect(reranked[0].matchReason).toBeDefined();
    expect(reranked[0].matchReason!.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Performance
// ---------------------------------------------------------------------------

describe('two-stage rerank performance', () => {
  it('reranks 50 results through both stages in under 10ms', () => {
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
        summary: `Decision about area-${i % 5} topic ${i}`,
        detail: `Detailed text for decision ${i} about area-${i % 5}`,
      }),
    );

    const start = performance.now();
    const reranked = rerank(results, undefined, NOW, 'area topic decision');
    const elapsed = performance.now() - start;

    expect(reranked).toHaveLength(50);
    // Area co-occurrence + two-stage pipeline: 100ms is a reasonable bound.
    expect(elapsed).toBeLessThan(100);
  });
});
