import { describe, it, expect } from 'vitest';
import { suppressResults, DEFAULT_SUPPRESSION_THRESHOLD } from '../../src/search/suppression.js';
import type { RerankedResult, SignalValues } from '../../src/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const defaultSignals: SignalValues = {
  semantic_score: 0.8,
  bm25_score: 0.5,
  recency_decay: 1.0,
  importance: 0.5,
  graph_connectivity: 0,
};

function makeReranked(
  overrides: Partial<RerankedResult> & { id: string; composite_score: number },
): RerankedResult {
  return {
    score: 0.8,
    type: 'decision',
    summary: 'test',
    detail: 'test detail',
    author: 'alice',
    affects: ['api'],
    created_at: '2026-03-24T00:00:00Z',
    status: 'active',
    signals: { ...defaultSignals },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// suppressResults
// ---------------------------------------------------------------------------

describe('suppressResults', () => {
  it('returns all results when there is no suppression opportunity', () => {
    const results = [
      makeReranked({ id: 'a', composite_score: 0.9, affects: ['api'] }),
    ];
    const { visible, suppressed_count } = suppressResults(results);
    expect(visible).toHaveLength(1);
    expect(suppressed_count).toBe(0);
  });

  it('returns empty output for empty input', () => {
    const { visible, suppressed_count } = suppressResults([]);
    expect(visible).toHaveLength(0);
    expect(suppressed_count).toBe(0);
  });

  it('suppresses below top when dominant result exists (>1.5x)', () => {
    const results = [
      makeReranked({ id: 'top', composite_score: 0.9, affects: ['auth'] }),
      makeReranked({ id: 'mid', composite_score: 0.3, affects: ['auth'] }),
      makeReranked({ id: 'low', composite_score: 0.2, affects: ['auth'] }),
    ];
    // 0.9 > 1.5 * 0.3 = 0.45 → dominant
    const { visible, suppressed_count } = suppressResults(results);
    expect(visible).toHaveLength(1);
    expect(visible[0].id).toBe('top');
    expect(suppressed_count).toBe(2);
  });

  it('keeps top 2 when no dominant result (scores close)', () => {
    const results = [
      makeReranked({ id: 'first', composite_score: 0.8, affects: ['db'] }),
      makeReranked({ id: 'second', composite_score: 0.7, affects: ['db'] }),
      makeReranked({ id: 'third', composite_score: 0.6, affects: ['db'] }),
      makeReranked({ id: 'fourth', composite_score: 0.5, affects: ['db'] }),
    ];
    // 0.8 < 1.5 * 0.7 = 1.05 → non-dominant
    const { visible, suppressed_count } = suppressResults(results);
    expect(visible).toHaveLength(2);
    expect(visible.map((r) => r.id)).toEqual(['first', 'second']);
    expect(suppressed_count).toBe(2);
  });

  it('exempts cross-area results from suppression', () => {
    // 'cross' appears in both 'api' and 'db' groups
    const results = [
      makeReranked({ id: 'top-api', composite_score: 0.95, affects: ['api'] }),
      makeReranked({ id: 'cross', composite_score: 0.3, affects: ['api', 'db'] }),
      makeReranked({ id: 'low-api', composite_score: 0.2, affects: ['api'] }),
    ];
    // In the 'api' group: 0.95 > 1.5 * 0.3 = 0.45 → dominant, suppress cross + low
    // But 'cross' is in 'db' group too (as the only member) — not suppressed there
    // Since 'cross' is NOT suppressed in all groups, it stays visible
    const { visible, suppressed_count } = suppressResults(results);
    expect(visible.find((r) => r.id === 'cross')).toBeDefined();
    expect(visible.find((r) => r.id === 'top-api')).toBeDefined();
    // 'low-api' only in 'api' group and suppressed there → truly suppressed
    expect(visible.find((r) => r.id === 'low-api')).toBeUndefined();
    expect(suppressed_count).toBe(1);
  });

  it('does not suppress results with empty affects', () => {
    const results = [
      makeReranked({ id: 'a', composite_score: 0.9, affects: ['api'] }),
      makeReranked({ id: 'no-area', composite_score: 0.2, affects: [] }),
      makeReranked({ id: 'b', composite_score: 0.1, affects: ['api'] }),
    ];
    const { visible, suppressed_count } = suppressResults(results);
    // 'no-area' has empty affects — exempt from all grouping
    expect(visible.find((r) => r.id === 'no-area')).toBeDefined();
  });

  it('includes suppressed results with --all flag', () => {
    const results = [
      makeReranked({ id: 'top', composite_score: 0.9, affects: ['auth'] }),
      makeReranked({ id: 'low', composite_score: 0.2, affects: ['auth'] }),
    ];
    // 0.9 > 1.5 * 0.2 = 0.3 → dominant
    const { visible, suppressed_count } = suppressResults(results, DEFAULT_SUPPRESSION_THRESHOLD, true);
    expect(visible).toHaveLength(2);
    expect(suppressed_count).toBe(1);
    const suppressed = visible.find((r) => r.id === 'low');
    expect(suppressed?.suppressed).toBe(true);
    const top = visible.find((r) => r.id === 'top');
    expect(top?.suppressed).toBeUndefined();
  });

  it('suppressed_count is accurate', () => {
    const results = [
      makeReranked({ id: 'a', composite_score: 0.95, affects: ['x'] }),
      makeReranked({ id: 'b', composite_score: 0.3, affects: ['x'] }),
      makeReranked({ id: 'c', composite_score: 0.2, affects: ['x'] }),
      makeReranked({ id: 'd', composite_score: 0.1, affects: ['x'] }),
    ];
    const { suppressed_count } = suppressResults(results);
    expect(suppressed_count).toBe(3); // all except top suppressed (dominant)
  });

  it('uses custom threshold', () => {
    const results = [
      makeReranked({ id: 'a', composite_score: 0.6, affects: ['y'] }),
      makeReranked({ id: 'b', composite_score: 0.5, affects: ['y'] }),
      makeReranked({ id: 'c', composite_score: 0.4, affects: ['y'] }),
    ];
    // With threshold 1.0: 0.6 > 1.0 * 0.5 → dominant → suppress b and c
    const { visible, suppressed_count } = suppressResults(results, 1.0);
    expect(suppressed_count).toBe(2);
    expect(visible).toHaveLength(1);
    expect(visible[0].id).toBe('a');
  });

  it('handles multiple area groups independently', () => {
    const results = [
      makeReranked({ id: 'top-api', composite_score: 0.9, affects: ['api'] }),
      makeReranked({ id: 'low-api', composite_score: 0.2, affects: ['api'] }),
      makeReranked({ id: 'top-db', composite_score: 0.85, affects: ['db'] }),
      makeReranked({ id: 'low-db', composite_score: 0.2, affects: ['db'] }),
    ];
    const { visible, suppressed_count } = suppressResults(results);
    expect(visible.map((r) => r.id).sort()).toEqual(['top-api', 'top-db']);
    expect(suppressed_count).toBe(2);
  });

  it('handles second score of 0 without dividing by zero', () => {
    const results = [
      makeReranked({ id: 'a', composite_score: 0.5, affects: ['x'] }),
      makeReranked({ id: 'b', composite_score: 0, affects: ['x'] }),
    ];
    // secondScore is 0, so topScore > threshold * 0 is always true when secondScore=0
    // but our check is `secondScore > 0 && topScore > threshold * secondScore`
    // so it falls through to non-dominant path → keep top 2
    const { visible, suppressed_count } = suppressResults(results);
    expect(visible).toHaveLength(2);
    expect(suppressed_count).toBe(0);
  });
});
