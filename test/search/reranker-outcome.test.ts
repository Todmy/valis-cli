/**
 * Tests for 028-phase13/Track 5a outcome adjustment in the search reranker.
 *
 * Two pure functions under test:
 *   - `hasFailureIntent(query)` — keyword heuristic for FR-014
 *   - `applyOutcomeAdjustment(results, query)` — FR-013 0.5x multiplier
 *
 * Plus an integration assertion on `rerank(...)`:
 *   - Two results on the same topic, one `outcome='success'` and one
 *     `outcome='failed'`. Without failure-intent the failed one is ranked
 *     below the success one. With failure-intent the multiplier vanishes.
 */

import { describe, it, expect } from 'vitest';
import {
  rerank,
  applyOutcomeAdjustment,
  hasFailureIntent,
  FAILED_OUTCOME_MULTIPLIER,
} from '../../src/search/reranker.js';
import type { RerankableResult } from '../../src/search/reranker.js';
import type { RerankedResult, SignalValues } from '../../src/types.js';

const NOW = new Date('2026-05-15T00:00:00Z').getTime();

function makeReranked(
  overrides: Partial<RerankedResult> & { id: string; composite_score: number },
): RerankedResult {
  const baseSignals: SignalValues = {
    semantic_score: 0.5,
    bm25_score: 0,
    recency_decay: 0.5,
    importance: 0.5,
    graph_connectivity: 0,
    cluster_boost: 0,
  };
  return {
    score: 0.5,
    type: 'decision',
    summary: null,
    detail: 'test',
    author: 'tester',
    affects: ['db'],
    created_at: new Date(NOW).toISOString(),
    status: 'active',
    signals: baseSignals,
    ...overrides,
  };
}

function makeRerankable(
  overrides: Partial<RerankableResult> & { id: string },
): RerankableResult {
  return {
    score: 0.8,
    type: 'decision',
    summary: null,
    detail: 'choosing a database',
    author: 'tester',
    affects: ['db'],
    created_at: new Date(NOW).toISOString(),
    status: 'active',
    confidence: 0.8,
    pinned: false,
    depends_on: [],
    bm25_score: 0,
    ...overrides,
  };
}

describe('hasFailureIntent', () => {
  const positive = [
    'what mistakes did we make',
    'what database choices failed',
    'where did we regress',
    'we broke the auth flow',
    'list our failures',
    'recent regression on payments',
    'biggest mistake on the API',
  ];
  const negative = [
    'database choice', // semantic neutral
    'success criteria for auth',
    'mistakenly stored', // word-boundary: 'mistakenly' doesn't match 'mistake' on its own
    '',
    'what works well',
  ];

  for (const q of positive) {
    it(`matches: ${JSON.stringify(q)}`, () => {
      expect(hasFailureIntent(q)).toBe(true);
    });
  }
  for (const q of negative) {
    it(`does NOT match: ${JSON.stringify(q)}`, () => {
      expect(hasFailureIntent(q)).toBe(false);
    });
  }

  it('returns false for undefined', () => {
    expect(hasFailureIntent(undefined)).toBe(false);
  });
});

describe('applyOutcomeAdjustment — pure function', () => {
  it('downranks failed-outcome rows by 0.5x in non-failure-intent queries', () => {
    const results: RerankedResult[] = [
      makeReranked({ id: 'a', composite_score: 0.8, outcome: 'success' }),
      makeReranked({ id: 'b', composite_score: 0.8, outcome: 'failed' }),
    ];

    const adjusted = applyOutcomeAdjustment(results, 'database choice');

    // a stays at 0.8, b drops to 0.4 → a ranks first.
    expect(adjusted.map((r) => r.id)).toEqual(['a', 'b']);
    expect(adjusted[0].composite_score).toBe(0.8);
    expect(adjusted[1].composite_score).toBe(0.4);
    expect(adjusted[0].outcome_multiplier).toBe(1.0);
    expect(adjusted[1].outcome_multiplier).toBe(FAILED_OUTCOME_MULTIPLIER);
  });

  it('suspends the multiplier when the query has failure-intent', () => {
    const results: RerankedResult[] = [
      makeReranked({ id: 'a', composite_score: 0.7, outcome: 'success' }),
      makeReranked({ id: 'b', composite_score: 0.8, outcome: 'failed' }),
    ];

    const adjusted = applyOutcomeAdjustment(
      results,
      'what database choices failed',
    );

    // Override fires → b keeps 0.8 and ranks ABOVE a's 0.7.
    expect(adjusted.map((r) => r.id)).toEqual(['b', 'a']);
    expect(adjusted[0].outcome_multiplier).toBe(1.0);
    expect(adjusted[1].outcome_multiplier).toBe(1.0);
    expect(adjusted.every((r) => r.failure_intent_override === true)).toBe(true);
  });

  it('does NOT downrank partial-outcome rows', () => {
    const results: RerankedResult[] = [
      makeReranked({ id: 'a', composite_score: 0.6, outcome: 'success' }),
      makeReranked({ id: 'b', composite_score: 0.5, outcome: 'partial' }),
    ];

    const adjusted = applyOutcomeAdjustment(results, 'auth flow');

    expect(adjusted.find((r) => r.id === 'b')!.composite_score).toBe(0.5);
    expect(adjusted.find((r) => r.id === 'b')!.outcome_multiplier).toBe(1.0);
  });

  it('does NOT downrank rows with unknown / missing outcome', () => {
    const results: RerankedResult[] = [
      makeReranked({ id: 'a', composite_score: 0.5, outcome: 'unknown' }),
      makeReranked({ id: 'b', composite_score: 0.5, outcome: null }),
      makeReranked({ id: 'c', composite_score: 0.5 }), // no outcome field
    ];

    const adjusted = applyOutcomeAdjustment(results, 'anything');

    for (const r of adjusted) {
      expect(r.outcome_multiplier).toBe(1.0);
    }
  });

  it('returns empty array for empty input (no throws)', () => {
    expect(applyOutcomeAdjustment([], 'anything')).toEqual([]);
  });
});

describe('rerank — outcome integration (FR-018)', () => {
  it('ranks success above failed for a neutral topic query', () => {
    const results: RerankableResult[] = [
      makeRerankable({ id: 'good', score: 0.85, outcome: 'success' }),
      makeRerankable({ id: 'bad', score: 0.85, outcome: 'failed' }),
    ];

    const reranked = rerank(results, undefined, NOW, 'database choice');

    expect(reranked.map((r) => r.id)).toEqual(['good', 'bad']);
    const bad = reranked.find((r) => r.id === 'bad')!;
    expect(bad.outcome_multiplier).toBe(FAILED_OUTCOME_MULTIPLIER);
    expect(bad.failure_intent_override).toBe(false);
  });

  it('lifts the multiplier for failure-intent queries — bad ranks at parity or above', () => {
    const results: RerankableResult[] = [
      makeRerankable({ id: 'good', score: 0.75, outcome: 'success' }),
      makeRerankable({ id: 'bad', score: 0.85, outcome: 'failed' }),
    ];

    const reranked = rerank(
      results,
      undefined,
      NOW,
      'what database choices failed',
    );

    // bad has the higher raw score AND no multiplier hit → ranks first.
    expect(reranked[0].id).toBe('bad');
    expect(reranked[0].outcome_multiplier).toBe(1.0);
    expect(reranked[0].failure_intent_override).toBe(true);
  });
});
