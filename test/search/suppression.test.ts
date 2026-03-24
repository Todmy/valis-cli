import { describe, it, expect } from 'vitest';
import { suppressResults, groupByAffectsArea } from '../../src/search/suppression.js';
import { rerank } from '../../src/search/reranker.js';
import type { RerankedResult, SearchResult, SignalValues } from '../../src/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const defaultSignals: SignalValues = {
  semantic_score: 0.5,
  bm25_score: 0.5,
  recency_decay: 0.5,
  importance: 0.5,
  graph_connectivity: 0.5,
};

function makeReranked(overrides: Partial<RerankedResult> = {}): RerankedResult {
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
    composite_score: overrides.composite_score ?? 0.5,
    signals: overrides.signals ?? { ...defaultSignals },
  };
}

// ---------------------------------------------------------------------------
// groupByAffectsArea
// ---------------------------------------------------------------------------

describe('groupByAffectsArea', () => {
  it('groups results by their affects areas', () => {
    const results = [
      makeReranked({ id: 'a', affects: ['auth', 'db'] }),
      makeReranked({ id: 'b', affects: ['auth'] }),
      makeReranked({ id: 'c', affects: ['db'] }),
    ];
    const groups = groupByAffectsArea(results);
    expect(groups.get('auth')?.length).toBe(2);
    expect(groups.get('db')?.length).toBe(2);
  });

  it('excludes results with empty affects', () => {
    const results = [
      makeReranked({ id: 'a', affects: [] }),
      makeReranked({ id: 'b', affects: ['auth'] }),
    ];
    const groups = groupByAffectsArea(results);
    expect(groups.size).toBe(1);
    expect(groups.get('auth')?.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// suppressResults
// ---------------------------------------------------------------------------

describe('suppressResults', () => {
  it('returns all results when no suppression is needed (single per area)', () => {
    const results = [
      makeReranked({ id: 'a', affects: ['auth'], composite_score: 0.9 }),
      makeReranked({ id: 'b', affects: ['db'], composite_score: 0.8 }),
    ];
    const { visible, suppressed_count } = suppressResults(results);
    expect(visible.length).toBe(2);
    expect(suppressed_count).toBe(0);
  });

  it('returns empty for empty input', () => {
    const { visible, suppressed_count } = suppressResults([]);
    expect(visible).toEqual([]);
    expect(suppressed_count).toBe(0);
  });

  it('suppresses below top when dominant (>1.5x threshold)', () => {
    const results = [
      makeReranked({ id: 'top', affects: ['auth'], composite_score: 0.9 }),
      makeReranked({ id: 'low1', affects: ['auth'], composite_score: 0.3 }),
      makeReranked({ id: 'low2', affects: ['auth'], composite_score: 0.2 }),
    ];
    const { visible, suppressed_count } = suppressResults(results, 1.5);
    expect(visible.length).toBe(1);
    expect(visible[0].id).toBe('top');
    expect(suppressed_count).toBe(2);
  });

  it('keeps top-2 when non-dominant (scores close)', () => {
    const results = [
      makeReranked({ id: 'first', affects: ['auth'], composite_score: 0.8 }),
      makeReranked({ id: 'second', affects: ['auth'], composite_score: 0.7 }),
      makeReranked({ id: 'third', affects: ['auth'], composite_score: 0.6 }),
      makeReranked({ id: 'fourth', affects: ['auth'], composite_score: 0.5 }),
    ];
    const { visible, suppressed_count } = suppressResults(results, 1.5);
    expect(visible.length).toBe(2);
    expect(visible.map((r) => r.id)).toContain('first');
    expect(visible.map((r) => r.id)).toContain('second');
    expect(suppressed_count).toBe(2);
  });

  it('cross-area results are not suppressed', () => {
    // 'cross' appears in both 'auth' and 'db'
    // It might be suppressed in 'auth' but not in 'db' (only 1 in db group)
    const results = [
      makeReranked({ id: 'top', affects: ['auth'], composite_score: 0.9 }),
      makeReranked({ id: 'cross', affects: ['auth', 'db'], composite_score: 0.3 }),
      makeReranked({ id: 'other', affects: ['auth'], composite_score: 0.2 }),
    ];
    const { visible, suppressed_count } = suppressResults(results, 1.5);
    // 'cross' is suppressed in 'auth' group (dominant top) but not in 'db' (only 1)
    // Since it's not suppressed in ALL groups, it remains visible
    expect(visible.map((r) => r.id)).toContain('cross');
    // 'other' is only in 'auth' and suppressed there
    expect(visible.map((r) => r.id)).not.toContain('other');
    expect(suppressed_count).toBe(1);
  });

  it('results with empty affects are never suppressed', () => {
    const results = [
      makeReranked({ id: 'top', affects: ['auth'], composite_score: 0.9 }),
      makeReranked({ id: 'no-affects', affects: [], composite_score: 0.1 }),
      makeReranked({ id: 'low', affects: ['auth'], composite_score: 0.2 }),
    ];
    const { visible, suppressed_count } = suppressResults(results, 1.5);
    expect(visible.map((r) => r.id)).toContain('no-affects');
  });

  it('--all flag includes suppressed results with suppressed label', () => {
    const results = [
      makeReranked({ id: 'top', affects: ['auth'], composite_score: 0.9 }),
      makeReranked({ id: 'low', affects: ['auth'], composite_score: 0.3 }),
    ];
    const { visible, suppressed_count } = suppressResults(results, 1.5, true);
    expect(visible.length).toBe(2);
    expect(suppressed_count).toBe(1);
    const lowResult = visible.find((r) => r.id === 'low');
    expect(lowResult?.suppressed).toBe(true);
    const topResult = visible.find((r) => r.id === 'top');
    expect(topResult?.suppressed).toBeUndefined();
  });

  it('suppressed_count is accurate', () => {
    const results = [
      makeReranked({ id: 'a', affects: ['x'], composite_score: 0.9 }),
      makeReranked({ id: 'b', affects: ['x'], composite_score: 0.3 }),
      makeReranked({ id: 'c', affects: ['x'], composite_score: 0.2 }),
      makeReranked({ id: 'd', affects: ['x'], composite_score: 0.1 }),
      makeReranked({ id: 'e', affects: ['y'], composite_score: 0.5 }),
    ];
    const { visible, suppressed_count } = suppressResults(results, 1.5);
    // In 'x': dominant (0.9 > 1.5 * 0.3), suppress b, c, d
    // 'e' is only in 'y' (alone), not suppressed
    expect(suppressed_count).toBe(3);
    expect(visible.length).toBe(2); // a + e
  });

  it('handles multiple areas with different suppression outcomes', () => {
    const results = [
      makeReranked({ id: 'a', affects: ['auth'], composite_score: 0.9 }),
      makeReranked({ id: 'b', affects: ['auth'], composite_score: 0.8 }),
      makeReranked({ id: 'c', affects: ['db'], composite_score: 0.9 }),
      makeReranked({ id: 'd', affects: ['db'], composite_score: 0.2 }),
    ];
    const { visible, suppressed_count } = suppressResults(results, 1.5);
    // 'auth': non-dominant (0.9 < 1.5 * 0.8 = 1.2), keep top 2 (a, b)
    // 'db': dominant (0.9 > 1.5 * 0.2 = 0.3), suppress d
    expect(visible.map((r) => r.id)).toContain('a');
    expect(visible.map((r) => r.id)).toContain('b');
    expect(visible.map((r) => r.id)).toContain('c');
    expect(visible.map((r) => r.id)).not.toContain('d');
    expect(suppressed_count).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// T051: Integration test — rerank + suppress end-to-end
// ---------------------------------------------------------------------------

function makeSearchResult(overrides: Partial<SearchResult> = {}): SearchResult {
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
    bm25_score: overrides.bm25_score ?? 0.5,
  };
}

describe('T051 integration: rerank + suppress pipeline', () => {
  const now = Date.now();

  it('5 same-area decisions: default returns top 2, --all returns all 5 with suppressed labels', () => {
    const rawResults: SearchResult[] = [
      makeSearchResult({ id: 'd1', score: 0.92, affects: ['auth'], confidence: 0.9, created_at: new Date(now - 1 * 86_400_000).toISOString() }),
      makeSearchResult({ id: 'd2', score: 0.88, affects: ['auth'], confidence: 0.85, created_at: new Date(now - 2 * 86_400_000).toISOString() }),
      makeSearchResult({ id: 'd3', score: 0.80, affects: ['auth'], confidence: 0.7, created_at: new Date(now - 10 * 86_400_000).toISOString() }),
      makeSearchResult({ id: 'd4', score: 0.75, affects: ['auth'], confidence: 0.6, created_at: new Date(now - 30 * 86_400_000).toISOString() }),
      makeSearchResult({ id: 'd5', score: 0.70, affects: ['auth'], confidence: 0.5, created_at: new Date(now - 60 * 86_400_000).toISOString() }),
    ];

    // Step 1: Rerank
    const reranked = rerank(rawResults, undefined, now);
    expect(reranked.length).toBe(5);
    // Composite scores present and sorted descending
    for (let i = 1; i < reranked.length; i++) {
      expect(reranked[i - 1].composite_score).toBeGreaterThanOrEqual(reranked[i].composite_score);
    }
    // Signal breakdown present
    for (const r of reranked) {
      expect(r.signals).toBeDefined();
      expect(r.composite_score).toBeGreaterThan(0);
    }

    // Step 2: Default suppression — non-dominant (close scores), keep top 2
    const defaultResult = suppressResults(reranked, 1.5, false);
    expect(defaultResult.visible.length).toBe(2);
    expect(defaultResult.suppressed_count).toBe(3);
    // No suppressed labels in default mode
    for (const r of defaultResult.visible) {
      expect(r.suppressed).toBeUndefined();
    }

    // Step 3: --all flag returns all 5 with suppressed labels on 3
    const allResult = suppressResults(reranked, 1.5, true);
    expect(allResult.visible.length).toBe(5);
    expect(allResult.suppressed_count).toBe(3);
    const suppressedItems = allResult.visible.filter((r) => r.suppressed === true);
    expect(suppressedItems.length).toBe(3);
  });

  it('mixed-area results: only same-area redundancies suppressed', () => {
    const rawResults: SearchResult[] = [
      makeSearchResult({ id: 'auth-1', score: 0.9, affects: ['auth'], confidence: 0.9, created_at: new Date(now - 1 * 86_400_000).toISOString() }),
      makeSearchResult({ id: 'auth-2', score: 0.85, affects: ['auth'], confidence: 0.8, created_at: new Date(now - 2 * 86_400_000).toISOString() }),
      makeSearchResult({ id: 'auth-3', score: 0.80, affects: ['auth'], confidence: 0.7, created_at: new Date(now - 5 * 86_400_000).toISOString() }),
      makeSearchResult({ id: 'db-1', score: 0.88, affects: ['database'], confidence: 0.85, created_at: new Date(now - 1 * 86_400_000).toISOString() }),
      makeSearchResult({ id: 'db-2', score: 0.82, affects: ['database'], confidence: 0.75, created_at: new Date(now - 3 * 86_400_000).toISOString() }),
    ];

    const reranked = rerank(rawResults, undefined, now);
    const { visible, suppressed_count } = suppressResults(reranked, 1.5, false);

    // auth group: non-dominant, keep top 2, suppress 1
    // db group: non-dominant, keep top 2 (only 2 items, nothing to suppress)
    expect(suppressed_count).toBe(1);
    expect(visible.length).toBe(4);
  });

  it('signal breakdown is preserved through rerank + suppress', () => {
    const rawResults: SearchResult[] = [
      makeSearchResult({
        id: 'pinned-1',
        score: 0.9,
        confidence: 0.8,
        pinned: true,
        bm25_score: 2.5,
        affects: ['api'],
      }),
    ];

    const reranked = rerank(rawResults, undefined, now);
    const { visible } = suppressResults(reranked, 1.5, false);

    expect(visible.length).toBe(1);
    const result = visible[0];
    expect(result.signals.semantic_score).toBeGreaterThan(0);
    expect(result.signals.recency_decay).toBe(1.0); // pinned -> no decay
    expect(result.signals.importance).toBe(1.0); // pinned with 0.8 conf -> 1.6 -> capped at 1.0
    expect(result.composite_score).toBeGreaterThan(0);
  });
});
