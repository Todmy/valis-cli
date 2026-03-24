import { describe, it, expect } from 'vitest';
import {
  jaccard,
  clusterByJaccard,
  averagePairwiseJaccard,
  deduplicatePatterns,
  detectPatterns,
  patternSummary,
} from '../../src/synthesis/patterns.js';
import type { PatternCandidate } from '../../src/types.js';
import type { ClusterDecision } from '../../src/synthesis/patterns.js';

// ---------------------------------------------------------------------------
// Jaccard similarity (T062)
// ---------------------------------------------------------------------------

describe('jaccard', () => {
  it('returns 1.0 for identical arrays', () => {
    expect(jaccard(['auth', 'api'], ['auth', 'api'])).toBe(1.0);
  });

  it('returns 0 for disjoint arrays', () => {
    expect(jaccard(['auth', 'api'], ['database', 'testing'])).toBe(0);
  });

  it('returns 0 for two empty arrays', () => {
    expect(jaccard([], [])).toBe(0);
  });

  it('returns 0 when one array is empty', () => {
    expect(jaccard(['auth'], [])).toBe(0);
  });

  it('computes correct value for partial overlap', () => {
    // intersection = {auth}, union = {auth, api, database} -> 1/3
    const result = jaccard(['auth', 'api'], ['auth', 'database']);
    expect(result).toBeCloseTo(1 / 3, 5);
  });

  it('computes correct value for high overlap', () => {
    // intersection = {auth, api}, union = {auth, api, database} -> 2/3
    const result = jaccard(['auth', 'api'], ['auth', 'api', 'database']);
    expect(result).toBeCloseTo(2 / 3, 5);
  });

  it('handles duplicate values in input arrays', () => {
    // Sets are {auth, api} and {auth, api} -> 1.0
    expect(jaccard(['auth', 'api', 'auth'], ['auth', 'api'])).toBe(1.0);
  });
});

// ---------------------------------------------------------------------------
// clusterByJaccard
// ---------------------------------------------------------------------------

describe('clusterByJaccard', () => {
  const makeDecision = (id: string, affects: string[]): ClusterDecision => ({
    id,
    affects,
    summary: `Decision ${id}`,
    type: 'decision',
    created_at: new Date().toISOString(),
  });

  it('clusters decisions with identical affects', () => {
    const decisions = [
      makeDecision('a', ['auth', 'api']),
      makeDecision('b', ['auth', 'api']),
      makeDecision('c', ['auth', 'api']),
    ];

    const clusters = clusterByJaccard(decisions, 0.3);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]).toHaveLength(3);
  });

  it('separates decisions with completely different affects', () => {
    const decisions = [
      makeDecision('a', ['auth']),
      makeDecision('b', ['database']),
      makeDecision('c', ['testing']),
    ];

    const clusters = clusterByJaccard(decisions, 0.3);
    expect(clusters).toHaveLength(3);
    expect(clusters.every((c) => c.length === 1)).toBe(true);
  });

  it('groups decisions with partial overlap above threshold', () => {
    // auth+api vs auth+api+db => jaccard = 2/3 > 0.3 => same cluster
    // auth+api vs testing => jaccard = 0 => different cluster
    const decisions = [
      makeDecision('a', ['auth', 'api']),
      makeDecision('b', ['auth', 'api', 'database']),
      makeDecision('c', ['testing', 'ci']),
    ];

    const clusters = clusterByJaccard(decisions, 0.3);
    expect(clusters).toHaveLength(2);

    const bigCluster = clusters.find((c) => c.length === 2)!;
    expect(bigCluster.map((d) => d.id).sort()).toEqual(['a', 'b']);
  });

  it('returns empty array for empty input', () => {
    const clusters = clusterByJaccard([], 0.3);
    expect(clusters).toHaveLength(0);
  });

  it('returns single-item clusters when threshold is very high', () => {
    const decisions = [
      makeDecision('a', ['auth', 'api']),
      makeDecision('b', ['auth', 'api', 'database']),
    ];

    // Jaccard = 2/3 ~= 0.667, which is below threshold 0.9
    const clusters = clusterByJaccard(decisions, 0.9);
    expect(clusters).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// averagePairwiseJaccard
// ---------------------------------------------------------------------------

describe('averagePairwiseJaccard', () => {
  const makeDecision = (id: string, affects: string[]): ClusterDecision => ({
    id,
    affects,
    summary: null,
    type: 'decision',
    created_at: new Date().toISOString(),
  });

  it('returns 0 for a single decision', () => {
    const cluster = [makeDecision('a', ['auth'])];
    expect(averagePairwiseJaccard(cluster)).toBe(0);
  });

  it('returns 0 for empty cluster', () => {
    expect(averagePairwiseJaccard([])).toBe(0);
  });

  it('returns 1.0 for decisions with identical affects', () => {
    const cluster = [
      makeDecision('a', ['auth', 'api']),
      makeDecision('b', ['auth', 'api']),
      makeDecision('c', ['auth', 'api']),
    ];
    expect(averagePairwiseJaccard(cluster)).toBe(1.0);
  });

  it('computes correct average for mixed overlaps', () => {
    const cluster = [
      makeDecision('a', ['auth']),      // a-b: 1/1=1, a-c: 1/2=0.5
      makeDecision('b', ['auth']),      // b-c: 1/2=0.5
      makeDecision('c', ['auth', 'api']),
    ];
    // Average: (1 + 0.5 + 0.5) / 3 = 2/3
    expect(averagePairwiseJaccard(cluster)).toBeCloseTo(2 / 3, 5);
  });
});

// ---------------------------------------------------------------------------
// deduplicatePatterns
// ---------------------------------------------------------------------------

describe('deduplicatePatterns', () => {
  it('removes candidates with >0.8 decision ID overlap', () => {
    const candidates: PatternCandidate[] = [
      {
        affects: ['auth'],
        decision_ids: ['a', 'b', 'c', 'd', 'e'],
        cohesion: 0.9,
        already_exists: false,
      },
      {
        affects: ['auth', 'api'],
        decision_ids: ['a', 'b', 'c', 'd', 'e'],  // identical IDs
        cohesion: 0.8,
        already_exists: false,
      },
    ];

    const result = deduplicatePatterns(candidates);
    expect(result).toHaveLength(1);
    expect(result[0].cohesion).toBe(0.9); // keeps higher cohesion
  });

  it('keeps candidates with <0.8 decision ID overlap', () => {
    const candidates: PatternCandidate[] = [
      {
        affects: ['auth'],
        decision_ids: ['a', 'b', 'c'],
        cohesion: 0.9,
        already_exists: false,
      },
      {
        affects: ['database'],
        decision_ids: ['d', 'e', 'f'],
        cohesion: 0.8,
        already_exists: false,
      },
    ];

    const result = deduplicatePatterns(candidates);
    expect(result).toHaveLength(2);
  });

  it('returns empty array for empty input', () => {
    expect(deduplicatePatterns([])).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// detectPatterns (full pipeline)
// ---------------------------------------------------------------------------

describe('detectPatterns', () => {
  const makeDecision = (
    id: string,
    affects: string[],
    daysAgo: number = 0,
  ): ClusterDecision => ({
    id,
    affects,
    summary: `Decision ${id}`,
    type: 'decision',
    created_at: new Date(Date.now() - daysAgo * 86_400_000).toISOString(),
  });

  it('detects a cluster of 3+ decisions in the same area', () => {
    const decisions = [
      makeDecision('a', ['auth', 'api']),
      makeDecision('b', ['auth', 'api']),
      makeDecision('c', ['auth', 'api']),
    ];

    const patterns = detectPatterns(decisions, 3, 30);
    expect(patterns.length).toBeGreaterThanOrEqual(1);
    expect(patterns[0].decision_ids).toHaveLength(3);
    expect(patterns[0].affects).toContain('auth');
  });

  it('returns empty when no area has enough decisions', () => {
    const decisions = [
      makeDecision('a', ['auth']),
      makeDecision('b', ['database']),
      makeDecision('c', ['testing']),
    ];

    const patterns = detectPatterns(decisions, 3, 30);
    expect(patterns).toHaveLength(0);
  });

  it('returns empty for empty input', () => {
    expect(detectPatterns([], 3, 30)).toHaveLength(0);
  });

  it('clusters decisions with overlapping but not identical areas', () => {
    const decisions = [
      makeDecision('a', ['auth', 'api']),
      makeDecision('b', ['auth', 'api', 'middleware']),
      makeDecision('c', ['auth', 'api']),
      makeDecision('d', ['database', 'migrations']),
    ];

    const patterns = detectPatterns(decisions, 3, 30);
    expect(patterns.length).toBeGreaterThanOrEqual(1);
    // The auth/api cluster should be detected
    const authPattern = patterns.find((p) => p.affects.includes('auth'));
    expect(authPattern).toBeDefined();
    expect(authPattern!.decision_ids).toHaveLength(3);
  });

  it('respects minCluster threshold', () => {
    const decisions = [
      makeDecision('a', ['auth']),
      makeDecision('b', ['auth']),
    ];

    // minCluster = 3 means 2 decisions is not enough
    expect(detectPatterns(decisions, 3, 30)).toHaveLength(0);

    // minCluster = 2 means 2 decisions is enough
    expect(detectPatterns(decisions, 2, 30).length).toBeGreaterThanOrEqual(1);
  });

  it('deduplicates overlapping pattern candidates', () => {
    // All 5 decisions share 'auth' and 'api', forming one pattern not two
    const decisions = [
      makeDecision('a', ['auth', 'api']),
      makeDecision('b', ['auth', 'api']),
      makeDecision('c', ['auth', 'api']),
      makeDecision('d', ['auth', 'api']),
      makeDecision('e', ['auth', 'api']),
    ];

    const patterns = detectPatterns(decisions, 3, 30);
    // Should be 1 pattern (deduplicated), not 2 (one for 'auth' and one for 'api')
    expect(patterns).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// patternSummary
// ---------------------------------------------------------------------------

describe('patternSummary', () => {
  it('generates a descriptive summary', () => {
    const summary = patternSummary(['auth', 'api'], 5, 30);
    expect(summary).toBe('Team pattern: auth, api — 5 decisions in 30 days');
  });

  it('handles single area', () => {
    const summary = patternSummary(['database'], 3, 7);
    expect(summary).toBe('Team pattern: database — 3 decisions in 7 days');
  });
});
