/**
 * Tests for `createSpotChecker` (#30 prep — SpotChecker production port).
 *
 * Mocks Qdrant scroll + query to verify self-join recall computation:
 *   - Happy path: source and target both score perfectly → ratio 1.0, passed
 *   - Regression: target retrieves fewer self-matches → ratio < 0.95, !passed
 *   - Inconclusive: too few samples available (corpus too sparse)
 *   - Inconclusive: baseline R@5 is 0 (source itself broken)
 *   - Deterministic sampling: same seed yields same sample set
 */

import { describe, it, expect, vi } from 'vitest';
import { createSpotChecker } from '../../src/cloud/spot-checker.js';

interface MockPoint {
  id: string;
  text: string;
}

function buildScrollMock(points: MockPoint[]) {
  return vi.fn(async (_collection: string, opts: { offset?: string | number; limit: number }) => {
    const startIndex = opts.offset
      ? points.findIndex((p) => p.id === opts.offset) + 1
      : 0;
    const slice = points.slice(startIndex, startIndex + opts.limit);
    return {
      points: slice.map((p) => ({
        id: p.id,
        payload: { contextual_text: p.text },
      })),
    };
  });
}

/**
 * Mock `qdrant.query` to return the top-K self-join result. `hitMap`
 * maps `${collection}:${query_text}` → list of point ids in returned order.
 * Defaults to no match if absent.
 */
function buildQueryMock(
  hitMap: Map<string, string[]>,
): ReturnType<typeof vi.fn> {
  return vi.fn(async (collection: string, opts: { query: { document: string }; limit: number }) => {
    const key = `${collection}:${opts.query.document}`;
    const hits = (hitMap.get(key) ?? []).slice(0, opts.limit);
    return { points: hits.map((id) => ({ id })) };
  });
}

describe('createSpotChecker', () => {
  it('returns inconclusive when fewer than 5 ground-truth points are available', async () => {
    const samples: MockPoint[] = Array.from({ length: 3 }, (_, i) => ({
      id: `d${i}`,
      text: `decision ${i}`,
    }));
    const scroll = buildScrollMock(samples);
    const query = vi.fn();
    const checker = createSpotChecker({
      qdrant: { scroll, query } as never,
      randomSeed: 42,
    });

    const result = await checker.measure({ source: 'v1', target: 'v2', sampleSize: 50 });
    expect(result.inconclusive).toBe(true);
    expect(result.passed).toBe(false);
    expect(query).not.toHaveBeenCalled(); // no self-join issued
  });

  it('returns passed=true when source and target recall are equal', async () => {
    const samples: MockPoint[] = Array.from({ length: 10 }, (_, i) => ({
      id: `d${i}`,
      text: `text-${i}`,
    }));
    const hitMap = new Map<string, string[]>();
    // Each decision retrieves itself in BOTH collections.
    for (const p of samples) {
      hitMap.set(`decisions:text-${p.id.slice(1)}`, [p.id]);
      hitMap.set(`decisions_v2:text-${p.id.slice(1)}`, [p.id]);
    }
    const scroll = buildScrollMock(samples);
    const query = buildQueryMock(hitMap);

    const checker = createSpotChecker({
      qdrant: { scroll, query } as never,
      randomSeed: 1,
    });
    const result = await checker.measure({ source: 'v1', target: 'v2', sampleSize: 10 });

    expect(result.inconclusive).toBe(false);
    expect(result.baseline_r_at_5).toBe(1.0);
    expect(result.target_r_at_5).toBe(1.0);
    expect(result.ratio).toBe(1.0);
    expect(result.passed).toBe(true);
  });

  it('returns passed=false when target recall regresses below the threshold', async () => {
    const samples: MockPoint[] = Array.from({ length: 10 }, (_, i) => ({
      id: `d${i}`,
      text: `text-${i}`,
    }));
    const hitMap = new Map<string, string[]>();
    // Source: all 10 self-match. Target: only 5 self-match (50% recall).
    for (const p of samples) {
      hitMap.set(`decisions:text-${p.id.slice(1)}`, [p.id]);
    }
    for (let i = 0; i < 5; i++) {
      hitMap.set(`decisions_v2:text-${i}`, [`d${i}`]);
    }
    // Remaining target queries return unrelated hits.
    for (let i = 5; i < 10; i++) {
      hitMap.set(`decisions_v2:text-${i}`, ['unrelated', 'noise']);
    }

    const scroll = buildScrollMock(samples);
    const query = buildQueryMock(hitMap);
    const checker = createSpotChecker({
      qdrant: { scroll, query } as never,
      randomSeed: 1,
    });
    const result = await checker.measure({ source: 'v1', target: 'v2', sampleSize: 10 });

    expect(result.baseline_r_at_5).toBe(1.0);
    expect(result.target_r_at_5).toBe(0.5);
    expect(result.ratio).toBe(0.5);
    expect(result.passed).toBe(false);
    expect(result.inconclusive).toBe(false);
  });

  it('returns inconclusive when baseline recall is 0 (source itself broken)', async () => {
    const samples: MockPoint[] = Array.from({ length: 10 }, (_, i) => ({
      id: `d${i}`,
      text: `text-${i}`,
    }));
    // No hits in either collection.
    const scroll = buildScrollMock(samples);
    const query = buildQueryMock(new Map());
    const checker = createSpotChecker({
      qdrant: { scroll, query } as never,
      randomSeed: 1,
    });

    const result = await checker.measure({ source: 'v1', target: 'v2', sampleSize: 10 });
    expect(result.inconclusive).toBe(true);
    expect(result.passed).toBe(false);
  });

  it('produces deterministic samples for the same randomSeed', async () => {
    const samples: MockPoint[] = Array.from({ length: 100 }, (_, i) => ({
      id: `d${i}`,
      text: `text-${i}`,
    }));
    const hitMap = new Map<string, string[]>();
    for (const p of samples) {
      hitMap.set(`decisions:${p.text}`, [p.id]);
      hitMap.set(`decisions_v2:${p.text}`, [p.id]);
    }
    const scroll1 = buildScrollMock(samples);
    const scroll2 = buildScrollMock(samples);
    const query1 = buildQueryMock(hitMap);
    const query2 = buildQueryMock(hitMap);

    const c1 = createSpotChecker({
      qdrant: { scroll: scroll1, query: query1 } as never,
      randomSeed: 7,
    });
    const c2 = createSpotChecker({
      qdrant: { scroll: scroll2, query: query2 } as never,
      randomSeed: 7,
    });
    const r1 = await c1.measure({ source: 'v1', target: 'v2', sampleSize: 20 });
    const r2 = await c2.measure({ source: 'v1', target: 'v2', sampleSize: 20 });
    expect(r1.sample_decision_ids).toEqual(r2.sample_decision_ids);
  });

  it('skips points missing contextual_text', async () => {
    const samplesWithGaps = [
      { id: 'd1', payload: { contextual_text: 'good' } },
      { id: 'd2', payload: {} }, // missing
      { id: 'd3', payload: { contextual_text: 'good3' } },
      { id: 'd4', payload: { detail: 'fallback-detail' } }, // falls through to detail
    ];
    const scroll = vi.fn(async () => ({ points: samplesWithGaps }));
    const query = buildQueryMock(
      new Map([
        ['decisions:good', ['d1']],
        ['decisions:good3', ['d3']],
        ['decisions:fallback-detail', ['d4']],
        ['decisions_v2:good', ['d1']],
        ['decisions_v2:good3', ['d3']],
        ['decisions_v2:fallback-detail', ['d4']],
      ]),
    );
    const checker = createSpotChecker({
      qdrant: { scroll, query } as never,
      randomSeed: 11,
    });
    const result = await checker.measure({ source: 'v1', target: 'v2', sampleSize: 3 });
    // Only 3 samples survive — exactly above the inconclusive threshold (≥5
    // is the threshold; 3 < 5 → inconclusive). Verifies the dropped d2 path.
    expect(result.sample_size).toBe(3);
    expect(result.inconclusive).toBe(true);
  });
});
