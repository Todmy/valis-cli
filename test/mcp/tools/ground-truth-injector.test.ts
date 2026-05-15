/**
 * Tests for `injectGroundTruth` (027/Track 4 — GroundTruthInjector deep module).
 *
 * Mirrors the unit-test style of `link-extractor.test.ts`: pure-function tests
 * driven by a deterministic mock SearchFn. Covers the three similarity bands,
 * caller-supplied-arg precedence, non-blocking guarantees, threshold clamping,
 * and empty/timeout/throw paths.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  injectGroundTruth,
  type SearchFn,
} from '../../../src/mcp/tools/ground-truth-injector.js';

function searchReturning(
  results: Array<{ id: string; similarity: number }>,
): SearchFn {
  return async () => results;
}

describe('injectGroundTruth — similarity tiers', () => {
  it('classifies top match ≥ 0.92 as duplicate and short-circuits the write', async () => {
    const ctx = await injectGroundTruth(
      'we chose Postgres',
      searchReturning([
        { id: 'd1', similarity: 0.95 },
        { id: 'd2', similarity: 0.6 },
      ]),
    );

    expect(ctx.status).toBe('duplicate_detected');
    expect(ctx.band).toBe('duplicate');
    expect(ctx.existing_id).toBe('d1');
    expect(ctx.top_similarity).toBe(0.95);
    // Only the duplicate ID is surfaced — the 0.6 second match is below
    // both the duplicate AND neighbour thresholds, so it would just be
    // noise in the duplicate-detected response.
    expect(ctx.candidates).toEqual([{ id: 'd1', similarity: 0.95 }]);
  });

  it('classifies top match in [0.7, 0.92) as neighbour and auto-populates depends_on', async () => {
    const ctx = await injectGroundTruth(
      'lesson from prior decision',
      searchReturning([
        { id: 'd1', similarity: 0.8 },
        { id: 'd2', similarity: 0.75 },
        { id: 'd3', similarity: 0.5 },
      ]),
    );

    expect(ctx.status).toBe('neighbours_linked');
    expect(ctx.band).toBe('neighbour');
    expect(ctx.existing_id).toBeUndefined();
    // Only matches above the 0.7 threshold survive; d3 (0.5) is filtered.
    expect(ctx.candidates.map((c) => c.id)).toEqual(['d1', 'd2']);
    expect(ctx.top_similarity).toBe(0.8);
  });

  it('caps neighbour candidates at maxCandidates (default 3)', async () => {
    const ctx = await injectGroundTruth(
      'related text',
      searchReturning([
        { id: 'd1', similarity: 0.85 },
        { id: 'd2', similarity: 0.82 },
        { id: 'd3', similarity: 0.78 },
        { id: 'd4', similarity: 0.74 },
        { id: 'd5', similarity: 0.71 },
      ]),
    );

    expect(ctx.candidates).toHaveLength(3);
    expect(ctx.candidates.map((c) => c.id)).toEqual(['d1', 'd2', 'd3']);
  });

  it('classifies top match < 0.7 as none', async () => {
    const ctx = await injectGroundTruth(
      'unrelated text',
      searchReturning([
        { id: 'd1', similarity: 0.6 },
        { id: 'd2', similarity: 0.4 },
      ]),
    );

    expect(ctx.status).toBe('no_matches');
    expect(ctx.band).toBe('none');
    expect(ctx.candidates).toEqual([]);
    expect(ctx.top_similarity).toBe(0.6);
  });

  it('boundary: similarity exactly 0.92 falls into the duplicate tier (closed upper bound)', async () => {
    const ctx = await injectGroundTruth(
      'exact-boundary text',
      searchReturning([{ id: 'd1', similarity: 0.92 }]),
    );

    expect(ctx.status).toBe('duplicate_detected');
    expect(ctx.band).toBe('duplicate');
  });

  it('boundary: similarity exactly 0.7 falls into the neighbour tier', async () => {
    const ctx = await injectGroundTruth(
      'exact-boundary text',
      searchReturning([{ id: 'd1', similarity: 0.7 }]),
    );

    expect(ctx.status).toBe('neighbours_linked');
    expect(ctx.band).toBe('neighbour');
  });

  it('returns no_matches with band=none when the search result is empty', async () => {
    const ctx = await injectGroundTruth(
      'first decision in project',
      searchReturning([]),
    );

    expect(ctx.status).toBe('no_matches');
    expect(ctx.band).toBe('none');
    expect(ctx.candidates).toEqual([]);
    expect(ctx.top_similarity).toBe(0);
  });
});

describe('injectGroundTruth — caller-arg precedence', () => {
  it('caller-supplied depends_on flips neighbours_linked → neighbours_informational', async () => {
    const ctx = await injectGroundTruth(
      'related text',
      searchReturning([{ id: 'd1', similarity: 0.8 }]),
      { callerSuppliedDependsOn: true },
    );

    expect(ctx.status).toBe('neighbours_informational');
    expect(ctx.candidates).toEqual([{ id: 'd1', similarity: 0.8 }]);
  });

  it('caller-supplied replaces suppresses the duplicate short-circuit', async () => {
    const ctx = await injectGroundTruth(
      'we revised our prior decision',
      searchReturning([{ id: 'd1', similarity: 0.96 }]),
      { callerSuppliedReplaces: true },
    );

    // Write proceeds — caller has explicit supersede intent. Detected
    // duplicate still surfaces in metadata as a neighbour-tier candidate
    // for audit/observability (band stays 'duplicate' to reflect what the
    // similarity actually said, even though we suppressed the short-circuit).
    expect(ctx.status).not.toBe('duplicate_detected');
    expect(ctx.band).toBe('duplicate');
    expect(ctx.candidates).toEqual([{ id: 'd1', similarity: 0.96 }]);
  });

  it('caller-supplied replaces + caller-supplied depends_on still informational', async () => {
    const ctx = await injectGroundTruth(
      'overriding both',
      searchReturning([{ id: 'd1', similarity: 0.96 }]),
      { callerSuppliedReplaces: true, callerSuppliedDependsOn: true },
    );

    expect(ctx.status).toBe('neighbours_informational');
  });
});

describe('injectGroundTruth — non-blocking failure modes (Constitution III)', () => {
  it('returns injector_failed when SearchFn throws synchronously', async () => {
    const ctx = await injectGroundTruth(
      'any text',
      async () => {
        throw new Error('qdrant unreachable');
      },
    );

    expect(ctx.status).toBe('injector_failed');
    expect(ctx.band).toBe('failed');
    expect(ctx.reason).toBe('qdrant unreachable');
    expect(ctx.candidates).toEqual([]);
  });

  it('returns injector_failed with reason=timeout when SearchFn hangs past timeoutMs', async () => {
    const hangs: SearchFn = () =>
      new Promise(() => {
        /* never resolves */
      });

    const ctx = await injectGroundTruth('any text', hangs, { timeoutMs: 30 });

    expect(ctx.status).toBe('injector_failed');
    expect(ctx.reason).toBe('timeout');
    expect(ctx.latency_ms).toBeGreaterThanOrEqual(30);
  });

  it('returns injector_failed when SearchFn returns a non-array value', async () => {
    const malformed: SearchFn = async () =>
      'unexpected shape' as unknown as Array<{ id: string; similarity: number }>;

    const ctx = await injectGroundTruth('any text', malformed);

    expect(ctx.status).toBe('injector_failed');
    expect(ctx.reason).toBe('invalid_search_result');
  });

  it('returns injector_failed with reason=empty_text on empty input', async () => {
    const search = vi.fn(searchReturning([]));
    const ctx = await injectGroundTruth('   ', search);

    expect(ctx.status).toBe('injector_failed');
    expect(ctx.reason).toBe('empty_text');
    expect(search).not.toHaveBeenCalled(); // no SearchFn invocation
  });

  it('never rejects the returned Promise — every failure surfaces as a structured context', async () => {
    const ctx = await injectGroundTruth('text', async () => {
      throw 'bare string thrown';
    });

    expect(ctx.status).toBe('injector_failed');
    expect(ctx.reason).toBe('bare string thrown');
  });
});

describe('injectGroundTruth — threshold + option clamping', () => {
  it('clamps duplicateThreshold above 1 down to 1.0 — similarity 0.99 then becomes neighbour, not duplicate', async () => {
    const ctx = await injectGroundTruth(
      'text',
      searchReturning([{ id: 'd1', similarity: 0.99 }]),
      { duplicateThreshold: 5 },
    );

    // 5 clamps to 1.0. 0.99 < 1.0 → falls out of duplicate band. 0.99 ≥ 0.7
    // → lands in neighbour. The clamp prevents off-by-one tier promotions.
    expect(ctx.band).toBe('neighbour');
    expect(ctx.status).toBe('neighbours_linked');
  });

  it('uses default thresholds when options are undefined', async () => {
    const ctx = await injectGroundTruth(
      'text',
      searchReturning([{ id: 'd1', similarity: 0.95 }]),
    );
    expect(ctx.status).toBe('duplicate_detected');
  });

  it('honours custom duplicateThreshold = 0.99 — 0.95 becomes a neighbour, not duplicate', async () => {
    const ctx = await injectGroundTruth(
      'text',
      searchReturning([{ id: 'd1', similarity: 0.95 }]),
      { duplicateThreshold: 0.99 },
    );

    expect(ctx.status).toBe('neighbours_linked');
    expect(ctx.band).toBe('neighbour');
  });

  it('caps maxCandidates at the hard ceiling (10)', async () => {
    const tooMany = Array.from({ length: 20 }, (_, i) => ({
      id: `d${i}`,
      similarity: 0.8 - i * 0.001,
    }));
    const ctx = await injectGroundTruth('text', searchReturning(tooMany), {
      maxCandidates: 50,
    });

    expect(ctx.candidates).toHaveLength(10);
  });

  it('floors maxCandidates < 1 back to 1', async () => {
    const ctx = await injectGroundTruth(
      'text',
      searchReturning([
        { id: 'd1', similarity: 0.85 },
        { id: 'd2', similarity: 0.82 },
      ]),
      { maxCandidates: 0 },
    );

    expect(ctx.candidates).toHaveLength(1);
  });
});
