/**
 * T010: Unit tests for suppression module.
 * T051: Integration test — 5 same-area decisions, default returns top 2,
 *       --all returns all 5 with suppressed labels.
 *
 * @phase 003-search-growth (T010, T051)
 */

import { describe, it, expect } from 'vitest';
import { suppressResults, groupByAffectsArea } from '../../src/search/suppression.js';
import { rerank } from '../../src/search/reranker.js';
import type { RerankedResult, SearchResult } from '../../src/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeReranked(
  overrides: Partial<RerankedResult> & { id: string },
): RerankedResult {
  return {
    score: 0.8,
    type: 'decision',
    summary: `Decision ${overrides.id}`,
    detail: `Detail for ${overrides.id}`,
    author: 'alice',
    affects: ['auth'],
    created_at: new Date().toISOString(),
    status: 'active',
    composite_score: 0.5,
    signals: {
      semantic_score: 0.8,
      bm25_score: 0.5,
      recency_decay: 0.9,
      importance: 0.7,
      graph_connectivity: 0.0,
    },
    ...overrides,
  };
}

function makeSearchResult(
  overrides: Partial<SearchResult> & { id: string },
): SearchResult {
  return {
    score: 0.8,
    type: 'decision',
    summary: `Decision ${overrides.id}`,
    detail: `Detail for ${overrides.id}`,
    author: 'alice',
    affects: ['auth'],
    created_at: new Date().toISOString(),
    status: 'active',
    confidence: 0.7,
    pinned: false,
    depends_on: [],
    bm25_score: 0.5,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// T010: Unit Tests for suppression
// ---------------------------------------------------------------------------

describe('suppressResults', () => {
  it('returns all results when there are fewer than 2 in any area', () => {
    const results = [
      makeReranked({ id: 'a', affects: ['auth'], composite_score: 0.9 }),
      makeReranked({ id: 'b', affects: ['payments'], composite_score: 0.8 }),
    ];
    const { visible, suppressed_count } = suppressResults(results);
    expect(visible).toHaveLength(2);
    expect(suppressed_count).toBe(0);
  });

  it('suppresses below top when dominant result (>1.5x second)', () => {
    const results = [
      makeReranked({ id: 'a', affects: ['auth'], composite_score: 0.9 }),
      makeReranked({ id: 'b', affects: ['auth'], composite_score: 0.3 }),
      makeReranked({ id: 'c', affects: ['auth'], composite_score: 0.2 }),
    ];
    // 0.9 > 1.5 * 0.3 = 0.45, so 'a' is dominant
    const { visible, suppressed_count } = suppressResults(results, 1.5, false);
    expect(visible).toHaveLength(1);
    expect(visible[0].id).toBe('a');
    expect(suppressed_count).toBe(2);
  });

  it('keeps top 2 when non-dominant', () => {
    const results = [
      makeReranked({ id: 'a', affects: ['auth'], composite_score: 0.9 }),
      makeReranked({ id: 'b', affects: ['auth'], composite_score: 0.7 }),
      makeReranked({ id: 'c', affects: ['auth'], composite_score: 0.6 }),
      makeReranked({ id: 'd', affects: ['auth'], composite_score: 0.5 }),
    ];
    // 0.9 < 1.5 * 0.7 = 1.05, so non-dominant
    const { visible, suppressed_count } = suppressResults(results, 1.5, false);
    expect(visible).toHaveLength(2);
    expect(visible[0].id).toBe('a');
    expect(visible[1].id).toBe('b');
    expect(suppressed_count).toBe(2);
  });

  it('exempts cross-area results from suppression', () => {
    // 'b' appears in both 'auth' and 'payments', and is not suppressed
    // in 'payments' because there's only 1 item there
    const results = [
      makeReranked({ id: 'a', affects: ['auth'], composite_score: 0.9 }),
      makeReranked({ id: 'b', affects: ['auth', 'payments'], composite_score: 0.3 }),
      makeReranked({ id: 'c', affects: ['auth'], composite_score: 0.2 }),
    ];
    const { visible, suppressed_count } = suppressResults(results, 1.5, false);
    // 'b' is suppressed in 'auth' but NOT in 'payments' (only 1 item there)
    // so 'b' is not truly suppressed (cross-area exemption)
    expect(visible.find((r) => r.id === 'b')).toBeDefined();
    // 'c' is suppressed in 'auth' and has no other area, so truly suppressed
    expect(visible.find((r) => r.id === 'c')).toBeUndefined();
    expect(suppressed_count).toBe(1);
  });

  it('handles results with empty affects (exempt from suppression)', () => {
    const results = [
      makeReranked({ id: 'a', affects: ['auth'], composite_score: 0.9 }),
      makeReranked({ id: 'b', affects: [], composite_score: 0.3 }),
      makeReranked({ id: 'c', affects: ['auth'], composite_score: 0.2 }),
    ];
    const { visible, suppressed_count } = suppressResults(results, 1.5, false);
    // 'b' has empty affects — never suppressed
    expect(visible.find((r) => r.id === 'b')).toBeDefined();
  });

  it('includes suppressed results with label when includeAll=true', () => {
    const results = [
      makeReranked({ id: 'a', affects: ['auth'], composite_score: 0.9 }),
      makeReranked({ id: 'b', affects: ['auth'], composite_score: 0.3 }),
      makeReranked({ id: 'c', affects: ['auth'], composite_score: 0.2 }),
    ];
    const { visible, suppressed_count } = suppressResults(results, 1.5, true);
    expect(visible).toHaveLength(3);
    expect(suppressed_count).toBe(2);
    expect(visible.find((r) => r.id === 'b')?.suppressed).toBe(true);
    expect(visible.find((r) => r.id === 'c')?.suppressed).toBe(true);
    expect(visible.find((r) => r.id === 'a')?.suppressed).toBeUndefined();
  });

  it('returns empty for empty input', () => {
    const { visible, suppressed_count } = suppressResults([]);
    expect(visible).toEqual([]);
    expect(suppressed_count).toBe(0);
  });

  it('suppressed_count is accurate', () => {
    const results = [
      makeReranked({ id: 'a', affects: ['auth'], composite_score: 0.9 }),
      makeReranked({ id: 'b', affects: ['auth'], composite_score: 0.7 }),
      makeReranked({ id: 'c', affects: ['auth'], composite_score: 0.6 }),
      makeReranked({ id: 'd', affects: ['auth'], composite_score: 0.5 }),
      makeReranked({ id: 'e', affects: ['auth'], composite_score: 0.4 }),
    ];
    // Non-dominant: top 2 kept, 3 suppressed
    const { suppressed_count } = suppressResults(results, 1.5, false);
    expect(suppressed_count).toBe(3);
  });
});

describe('groupByAffectsArea', () => {
  it('groups by each area', () => {
    const results = [
      makeReranked({ id: 'a', affects: ['auth', 'payments'] }),
      makeReranked({ id: 'b', affects: ['auth'] }),
    ];
    const groups = groupByAffectsArea(results);
    expect(groups.get('auth')?.length).toBe(2);
    expect(groups.get('payments')?.length).toBe(1);
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
// T051: Integration test — 5 same-area decisions through rerank + suppress
// ---------------------------------------------------------------------------

describe('integration: rerank + suppress pipeline (T051)', () => {
  it('5 same-area decisions: default returns top 2, --all returns all 5 with suppressed labels', () => {
    const now = Date.now();
    // Create 5 decisions in the same area with varying scores
    const results: SearchResult[] = [
      makeSearchResult({
        id: 'auth-1',
        score: 0.95,
        affects: ['auth'],
        confidence: 0.9,
        created_at: new Date(now).toISOString(),
      }),
      makeSearchResult({
        id: 'auth-2',
        score: 0.90,
        affects: ['auth'],
        confidence: 0.85,
        created_at: new Date(now - 1 * 86_400_000).toISOString(),
      }),
      makeSearchResult({
        id: 'auth-3',
        score: 0.85,
        affects: ['auth'],
        confidence: 0.80,
        created_at: new Date(now - 5 * 86_400_000).toISOString(),
      }),
      makeSearchResult({
        id: 'auth-4',
        score: 0.80,
        affects: ['auth'],
        confidence: 0.75,
        created_at: new Date(now - 10 * 86_400_000).toISOString(),
      }),
      makeSearchResult({
        id: 'auth-5',
        score: 0.75,
        affects: ['auth'],
        confidence: 0.70,
        created_at: new Date(now - 20 * 86_400_000).toISOString(),
      }),
    ];

    // Step 1: Rerank
    const reranked = rerank(results, undefined, now);
    expect(reranked).toHaveLength(5);

    // All should have composite_score and signals
    for (const r of reranked) {
      expect(r.composite_score).toBeGreaterThan(0);
      expect(r.signals).toBeDefined();
    }

    // Results are sorted by composite_score descending
    for (let i = 1; i < reranked.length; i++) {
      expect(reranked[i - 1].composite_score).toBeGreaterThanOrEqual(
        reranked[i].composite_score,
      );
    }

    // Step 2: Suppress (default — no --all flag)
    const { visible: defaultVisible, suppressed_count: defaultSuppressed } =
      suppressResults(reranked, 1.5, false);

    // With similar scores (non-dominant), top 2 are kept
    expect(defaultVisible.length).toBeLessThanOrEqual(2);
    expect(defaultSuppressed).toBeGreaterThanOrEqual(3);
    // No suppressed label on visible results
    for (const r of defaultVisible) {
      expect(r.suppressed).toBeUndefined();
    }

    // Step 3: Suppress with --all flag
    const { visible: allVisible, suppressed_count: allSuppressed } =
      suppressResults(reranked, 1.5, true);

    expect(allVisible).toHaveLength(5);
    expect(allSuppressed).toBe(defaultSuppressed);

    // Suppressed results should have the suppressed label
    const suppressedResults = allVisible.filter((r) => r.suppressed === true);
    expect(suppressedResults.length).toBe(allSuppressed);
  });

  it('results from different areas are not suppressed', () => {
    const now = Date.now();
    const results: SearchResult[] = [
      makeSearchResult({
        id: 'auth-1',
        score: 0.95,
        affects: ['auth'],
        confidence: 0.9,
        created_at: new Date(now).toISOString(),
      }),
      makeSearchResult({
        id: 'payments-1',
        score: 0.90,
        affects: ['payments'],
        confidence: 0.85,
        created_at: new Date(now).toISOString(),
      }),
      makeSearchResult({
        id: 'db-1',
        score: 0.85,
        affects: ['database'],
        confidence: 0.80,
        created_at: new Date(now).toISOString(),
      }),
    ];

    const reranked = rerank(results, undefined, now);
    const { visible, suppressed_count } = suppressResults(reranked, 1.5, false);

    // Each area has only 1 result, so nothing is suppressed
    expect(visible).toHaveLength(3);
    expect(suppressed_count).toBe(0);
  });

  it('composite_score includes signal breakdown', () => {
    const now = Date.now();
    const results: SearchResult[] = [
      makeSearchResult({
        id: 'test-1',
        score: 0.9,
        affects: ['auth'],
        confidence: 0.8,
        pinned: true,
        created_at: new Date(now - 90 * 86_400_000).toISOString(),
      }),
    ];

    const reranked = rerank(results, undefined, now);
    const r = reranked[0];

    // Signal breakdown should be present and valid
    expect(r.signals.semantic_score).toBeGreaterThan(0);
    expect(r.signals.recency_decay).toBe(1.0); // Pinned => no decay
    expect(r.signals.importance).toBe(1.0); // Pinned with 0.8 confidence => min(1.0, 0.8*2) = 1.0
    expect(r.composite_score).toBeGreaterThan(0);
  });
});
