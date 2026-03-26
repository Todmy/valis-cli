import { describe, it, expect } from 'vitest';
import {
  tokenOverlapScore,
  negationAwarenessScore,
  freshnessBoost,
  tokenize,
  contentAwareRecencyDecay,
  areaCooccurrence,
  CONTENT_HALF_LIFE_DAYS,
  clusterBoost,
} from '../../src/search/signals.js';

const MS_PER_DAY = 86_400_000;
const NOW = new Date('2026-03-24T00:00:00Z').getTime();

// ---------------------------------------------------------------------------
// tokenize
// ---------------------------------------------------------------------------

describe('tokenize', () => {
  it('lowercases and splits on whitespace', () => {
    expect(tokenize('JWT Auth')).toEqual(['jwt', 'auth']);
  });

  it('removes stopwords', () => {
    const tokens = tokenize('what is the best approach');
    expect(tokens).not.toContain('what');
    expect(tokens).not.toContain('is');
    expect(tokens).not.toContain('the');
    expect(tokens).toContain('best');
    expect(tokens).toContain('approach');
  });

  it('removes single-character tokens', () => {
    expect(tokenize('a b c JWT')).toEqual(['jwt']);
  });

  it('strips punctuation', () => {
    const tokens = tokenize('hello? world! (test)');
    expect(tokens).toContain('hello');
    expect(tokens).toContain('world');
    expect(tokens).toContain('test');
  });

  it('returns empty array for empty input', () => {
    expect(tokenize('')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// tokenOverlapScore
// ---------------------------------------------------------------------------

describe('tokenOverlapScore', () => {
  it('returns 1.0 for full overlap', () => {
    expect(tokenOverlapScore('JWT auth', 'We use JWT for auth')).toBe(1.0);
  });

  it('returns 0.5 for partial overlap', () => {
    expect(tokenOverlapScore('JWT database', 'We use JWT for auth')).toBe(0.5);
  });

  it('returns 0 for no overlap', () => {
    expect(tokenOverlapScore('Redis caching', 'PostgreSQL database setup')).toBe(0);
  });

  it('is case-insensitive', () => {
    expect(tokenOverlapScore('JWT AUTH', 'jwt auth tokens')).toBe(1.0);
  });

  it('returns 0 for empty query', () => {
    expect(tokenOverlapScore('', 'some document text')).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// negationAwarenessScore
// ---------------------------------------------------------------------------

describe('negationAwarenessScore', () => {
  it('returns 0 when query has no negation', () => {
    expect(
      negationAwarenessScore(false, ['redis', 'caching'], 'Avoid Redis for caching'),
    ).toBe(0);
  });

  it('returns 0 when entities array is empty', () => {
    expect(negationAwarenessScore(true, [], 'Do not use Redis')).toBe(0);
  });

  it('returns 0 when document has no negation language', () => {
    expect(
      negationAwarenessScore(true, ['redis', 'caching'], 'Redis caching configuration guide'),
    ).toBe(0);
  });

  it('returns 1.0 when all entities match in negation context', () => {
    const score = negationAwarenessScore(
      true,
      ['redis', 'caching'],
      'Avoid Redis for caching entirely.',
    );
    expect(score).toBe(1.0);
  });

  it('returns partial score when some entities match', () => {
    const score = negationAwarenessScore(
      true,
      ['redis', 'mongodb', 'caching'],
      'Avoid Redis for caching. Prefer Postgres.',
    );
    expect(score).toBeCloseTo(2 / 3, 5);
  });
});

// ---------------------------------------------------------------------------
// freshnessBoost
// ---------------------------------------------------------------------------

describe('freshnessBoost', () => {
  it('returns 0 when no affects tags', () => {
    const results = [
      { id: 'a', created_at: new Date(NOW).toISOString(), affects: [] },
      { id: 'b', created_at: new Date(NOW - 10 * MS_PER_DAY).toISOString(), affects: ['api'] },
    ];
    expect(freshnessBoost('a', results[0].created_at, [], results)).toBe(0);
  });

  it('returns 1.0 for the newest decision among area peers', () => {
    const results = [
      { id: 'new', created_at: new Date(NOW).toISOString(), affects: ['auth'] },
      { id: 'mid', created_at: new Date(NOW - 30 * MS_PER_DAY).toISOString(), affects: ['auth'] },
      { id: 'old', created_at: new Date(NOW - 90 * MS_PER_DAY).toISOString(), affects: ['auth'] },
    ];
    expect(freshnessBoost('new', results[0].created_at, ['auth'], results)).toBe(1.0);
  });

  it('returns 0 for the oldest decision among area peers', () => {
    const results = [
      { id: 'new', created_at: new Date(NOW).toISOString(), affects: ['auth'] },
      { id: 'mid', created_at: new Date(NOW - 30 * MS_PER_DAY).toISOString(), affects: ['auth'] },
      { id: 'old', created_at: new Date(NOW - 90 * MS_PER_DAY).toISOString(), affects: ['auth'] },
    ];
    expect(freshnessBoost('old', results[2].created_at, ['auth'], results)).toBe(0);
  });

  it('returns 0 when no area peers exist', () => {
    const results = [
      { id: 'a', created_at: new Date(NOW).toISOString(), affects: ['api'] },
      { id: 'b', created_at: new Date(NOW - 10 * MS_PER_DAY).toISOString(), affects: ['database'] },
    ];
    expect(freshnessBoost('a', results[0].created_at, ['api'], results)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// contentAwareRecencyDecay (Q4-A)
// ---------------------------------------------------------------------------

describe('contentAwareRecencyDecay', () => {
  it('returns 1.0 for pinned decisions regardless of type', () => {
    const createdAt = new Date(NOW - 365 * MS_PER_DAY).toISOString();
    expect(contentAwareRecencyDecay(createdAt, 'lesson', 90, true, NOW)).toBe(1.0);
  });

  it('uses type-specific half-life for constraints (365 days)', () => {
    const createdAt = new Date(NOW - 365 * MS_PER_DAY).toISOString();
    // constraint has 365-day half-life -> at 365 days, score should be ~0.5
    const score = contentAwareRecencyDecay(createdAt, 'constraint', 90, false, NOW);
    expect(score).toBeCloseTo(0.5, 2);
  });

  it('uses shorter half-life for lessons (30 days)', () => {
    const createdAt = new Date(NOW - 30 * MS_PER_DAY).toISOString();
    // lesson has 30-day half-life -> at 30 days, score should be ~0.5
    const score = contentAwareRecencyDecay(createdAt, 'lesson', 90, false, NOW);
    expect(score).toBeCloseTo(0.5, 2);
  });

  it('uses medium half-life for decisions (180 days)', () => {
    const createdAt = new Date(NOW - 180 * MS_PER_DAY).toISOString();
    const score = contentAwareRecencyDecay(createdAt, 'decision', 90, false, NOW);
    expect(score).toBeCloseTo(0.5, 2);
  });

  it('defaults to pending type when undefined', () => {
    const createdAt = new Date(NOW - 90 * MS_PER_DAY).toISOString();
    const score = contentAwareRecencyDecay(createdAt, undefined, 90, false, NOW);
    // pending has 90-day half-life
    expect(score).toBeCloseTo(0.5, 2);
  });

  it('scales type half-life by base half-life', () => {
    const createdAt = new Date(NOW - 60 * MS_PER_DAY).toISOString();
    // With baseHalfLifeDays=180, scale factor = 180/90 = 2.0
    // lesson type: 30 * 2.0 = 60-day adjusted half-life
    const score = contentAwareRecencyDecay(createdAt, 'lesson', 180, false, NOW);
    expect(score).toBeCloseTo(0.5, 2);
  });

  it('constraints decay slower than lessons at same age', () => {
    const createdAt = new Date(NOW - 90 * MS_PER_DAY).toISOString();
    const constraintScore = contentAwareRecencyDecay(createdAt, 'constraint', 90, false, NOW);
    const lessonScore = contentAwareRecencyDecay(createdAt, 'lesson', 90, false, NOW);
    expect(constraintScore).toBeGreaterThan(lessonScore);
  });
});

// ---------------------------------------------------------------------------
// CONTENT_HALF_LIFE_DAYS
// ---------------------------------------------------------------------------

describe('CONTENT_HALF_LIFE_DAYS', () => {
  it('has expected values for all types', () => {
    expect(CONTENT_HALF_LIFE_DAYS.decision).toBe(180);
    expect(CONTENT_HALF_LIFE_DAYS.constraint).toBe(365);
    expect(CONTENT_HALF_LIFE_DAYS.pattern).toBe(90);
    expect(CONTENT_HALF_LIFE_DAYS.lesson).toBe(30);
    expect(CONTENT_HALF_LIFE_DAYS.pending).toBe(90);
  });
});

// ---------------------------------------------------------------------------
// areaCooccurrence (Q4-C)
// ---------------------------------------------------------------------------

describe('areaCooccurrence', () => {
  it('returns 0 when no affects exist', () => {
    const results = [
      { id: 'a', affects: [] },
      { id: 'b', affects: [] },
    ];
    expect(areaCooccurrence('a', results)).toBe(0);
  });

  it('returns 0 when no peers share affects', () => {
    const results = [
      { id: 'a', affects: ['api'] },
      { id: 'b', affects: ['database'] },
    ];
    expect(areaCooccurrence('a', results)).toBe(0);
  });

  it('returns positive score when peers share affects', () => {
    const results = [
      { id: 'a', affects: ['api'] },
      { id: 'b', affects: ['api'] },
      { id: 'c', affects: ['api'] },
    ];
    const score = areaCooccurrence('a', results);
    expect(score).toBeGreaterThan(0);
  });

  it('returns 1.0 for the most connected decision', () => {
    const results = [
      { id: 'a', affects: ['api', 'auth', 'db'] },
      { id: 'b', affects: ['api'] },
      { id: 'c', affects: ['auth'] },
      { id: 'd', affects: ['db'] },
    ];
    // 'a' shares areas with b, c, d (3 neighbors) — maximum
    expect(areaCooccurrence('a', results)).toBeCloseTo(1.0, 5);
  });
});

// ---------------------------------------------------------------------------
// clusterBoost (Q5)
// ---------------------------------------------------------------------------

describe('clusterBoost', () => {
  it('returns 0 for small clusters', () => {
    expect(clusterBoost(0)).toBe(0);
    expect(clusterBoost(4)).toBe(0);
  });

  it('returns 1.0 for clusters with 5+ members', () => {
    expect(clusterBoost(5)).toBe(1.0);
    expect(clusterBoost(10)).toBe(1.0);
  });

  it('supports custom minMembers threshold', () => {
    expect(clusterBoost(3, 3)).toBe(1.0);
    expect(clusterBoost(2, 3)).toBe(0);
  });
});
