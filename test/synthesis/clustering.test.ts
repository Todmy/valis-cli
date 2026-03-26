import { describe, it, expect } from 'vitest';
import {
  cosineSimilarity,
  clusterPoints,
} from '../../src/synthesis/clustering.js';
import { buildClusterSummary } from '../../src/synthesis/compress.js';
import type { Cluster } from '../../src/synthesis/clustering.js';

// ---------------------------------------------------------------------------
// Helper: generate a deterministic unit vector at a given angle
// ---------------------------------------------------------------------------

function vectorAtAngle(angleDeg: number, dims = 8): number[] {
  // Create a vector that varies in the first two dimensions by angle,
  // with remaining dimensions zeroed. This gives us controlled cosine
  // similarity between vectors.
  const rad = (angleDeg * Math.PI) / 180;
  const vec = new Array(dims).fill(0);
  vec[0] = Math.cos(rad);
  vec[1] = Math.sin(rad);
  return vec;
}

/** Build a mock VectorPoint for clustering tests. */
function makePoint(
  id: string,
  vector: number[],
  affects: string[] = [],
  summary: string | null = `Decision ${id}`,
) {
  return {
    id,
    vector,
    detail: `Detail for ${id}`,
    summary,
    affects,
    created_at: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// cosineSimilarity
// ---------------------------------------------------------------------------

describe('cosineSimilarity', () => {
  it('returns 1.0 for identical vectors', () => {
    const v = [1, 2, 3, 4];
    expect(cosineSimilarity(v, v)).toBeCloseTo(1.0, 5);
  });

  it('returns 0.0 for orthogonal vectors', () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0.0, 5);
  });

  it('returns 0.0 for empty vectors', () => {
    expect(cosineSimilarity([], [])).toBe(0.0);
  });

  it('returns 0.0 when one vector is all zeros', () => {
    expect(cosineSimilarity([0, 0, 0], [1, 2, 3])).toBe(0.0);
  });

  it('returns 0.0 for different-length vectors', () => {
    expect(cosineSimilarity([1, 2], [1, 2, 3])).toBe(0.0);
  });

  it('computes correct similarity for known vectors', () => {
    // cos(45 degrees) ~ 0.707
    const a = vectorAtAngle(0);
    const b = vectorAtAngle(45);
    expect(cosineSimilarity(a, b)).toBeCloseTo(Math.cos(Math.PI / 4), 3);
  });

  it('returns high similarity for nearly parallel vectors', () => {
    const a = vectorAtAngle(0);
    const b = vectorAtAngle(5); // 5 degrees apart
    expect(cosineSimilarity(a, b)).toBeGreaterThan(0.99);
  });
});

// ---------------------------------------------------------------------------
// clusterPoints
// ---------------------------------------------------------------------------

describe('clusterPoints', () => {
  it('returns empty array for empty input', () => {
    expect(clusterPoints([], 0.75, 3)).toHaveLength(0);
  });

  it('returns no clusters when all points are dissimilar', () => {
    // Orthogonal vectors — cosine similarity = 0
    const points = [
      makePoint('a', [1, 0, 0, 0]),
      makePoint('b', [0, 1, 0, 0]),
      makePoint('c', [0, 0, 1, 0]),
      makePoint('d', [0, 0, 0, 1]),
    ];

    const clusters = clusterPoints(points, 0.75, 2);
    expect(clusters).toHaveLength(0);
  });

  it('clusters identical vectors together', () => {
    const vec = [1, 2, 3, 4];
    const points = [
      makePoint('a', vec, ['auth']),
      makePoint('b', vec, ['auth']),
      makePoint('c', vec, ['auth']),
      makePoint('d', [0, 0, 0, 1], ['database']),
    ];

    const clusters = clusterPoints(points, 0.75, 3);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].size).toBe(3);
    expect(clusters[0].decision_ids).toContain('a');
    expect(clusters[0].decision_ids).toContain('b');
    expect(clusters[0].decision_ids).toContain('c');
    expect(clusters[0].decision_ids).not.toContain('d');
  });

  it('enforces minimum cluster size', () => {
    const vec = [1, 2, 3, 4];
    const points = [
      makePoint('a', vec, ['auth']),
      makePoint('b', vec, ['auth']),
    ];

    // minClusterSize = 3 — two points don't qualify
    expect(clusterPoints(points, 0.75, 3)).toHaveLength(0);

    // minClusterSize = 2 — two points qualify
    expect(clusterPoints(points, 0.75, 2)).toHaveLength(1);
  });

  it('respects similarity threshold', () => {
    // Two groups: near-0-degree vectors and 90-degree vector
    const points = [
      makePoint('a', vectorAtAngle(0), ['auth']),
      makePoint('b', vectorAtAngle(5), ['auth']),   // very similar to a
      makePoint('c', vectorAtAngle(10), ['auth']),  // very similar to a,b
      makePoint('d', vectorAtAngle(90), ['database']), // orthogonal
    ];

    // High threshold: group a,b,c (cos(10deg) ~ 0.985 > 0.95)
    const highThreshold = clusterPoints(points, 0.95, 2);
    expect(highThreshold).toHaveLength(1);
    expect(highThreshold[0].size).toBe(3);

    // At very high threshold 0.999: cos(5deg)~0.9962 < 0.999, so no edges form
    // and no clusters exist even at minClusterSize=2
    const veryHighThreshold = clusterPoints(points, 0.999, 2);
    expect(veryHighThreshold).toHaveLength(0);
  });

  it('forms two separate clusters for distinct groups', () => {
    const points = [
      makePoint('a1', vectorAtAngle(0), ['auth']),
      makePoint('a2', vectorAtAngle(2), ['auth']),
      makePoint('a3', vectorAtAngle(4), ['auth']),
      makePoint('b1', vectorAtAngle(90), ['database']),
      makePoint('b2', vectorAtAngle(92), ['database']),
      makePoint('b3', vectorAtAngle(94), ['database']),
    ];

    const clusters = clusterPoints(points, 0.95, 3);
    expect(clusters).toHaveLength(2);

    const ids0 = clusters[0].decision_ids.sort();
    const ids1 = clusters[1].decision_ids.sort();
    // One cluster has a1,a2,a3 and the other has b1,b2,b3
    expect(
      (ids0.includes('a1') && ids0.includes('a2') && ids0.includes('a3')) ||
      (ids1.includes('a1') && ids1.includes('a2') && ids1.includes('a3'))
    ).toBe(true);
  });

  it('computes cohesion correctly for identical vectors', () => {
    const vec = [1, 0, 0, 0];
    const points = [
      makePoint('a', vec),
      makePoint('b', vec),
      makePoint('c', vec),
    ];

    const clusters = clusterPoints(points, 0.5, 2);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].cohesion).toBeCloseTo(1.0, 5);
  });

  it('sorts clusters by size descending', () => {
    const points = [
      // Group 1: 4 points
      makePoint('a1', vectorAtAngle(0)),
      makePoint('a2', vectorAtAngle(1)),
      makePoint('a3', vectorAtAngle(2)),
      makePoint('a4', vectorAtAngle(3)),
      // Group 2: 3 points
      makePoint('b1', vectorAtAngle(90)),
      makePoint('b2', vectorAtAngle(91)),
      makePoint('b3', vectorAtAngle(92)),
    ];

    const clusters = clusterPoints(points, 0.95, 3);
    expect(clusters).toHaveLength(2);
    expect(clusters[0].size).toBeGreaterThanOrEqual(clusters[1].size);
  });

  it('selects centroid as the most central point', () => {
    // The centroid should be the vector closest to the cluster center
    const points = [
      makePoint('a', vectorAtAngle(0)),
      makePoint('center', vectorAtAngle(5)),
      makePoint('b', vectorAtAngle(10)),
    ];

    const clusters = clusterPoints(points, 0.5, 3);
    expect(clusters).toHaveLength(1);
    // The center point (angle 5) has the highest average similarity
    // to both 0 and 10 degree vectors
    expect(clusters[0].centroid_text).toBe('Decision center');
  });

  it('unions affects from all decisions in a cluster', () => {
    const vec = [1, 2, 3, 4];
    const points = [
      makePoint('a', vec, ['auth', 'api']),
      makePoint('b', vec, ['auth', 'database']),
      makePoint('c', vec, ['api', 'testing']),
    ];

    const clusters = clusterPoints(points, 0.5, 3);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].affects).toContain('auth');
    expect(clusters[0].affects).toContain('api');
    expect(clusters[0].affects).toContain('database');
    expect(clusters[0].affects).toContain('testing');
  });

  it('uses detail text for centroid when summary is null', () => {
    const vec = [1, 2, 3, 4];
    const points = [
      makePoint('a', vec, [], null),
      makePoint('b', vec, [], null),
      makePoint('c', vec, [], null),
    ];

    const clusters = clusterPoints(points, 0.5, 3);
    expect(clusters).toHaveLength(1);
    // Should fall back to detail text
    expect(clusters[0].centroid_text).toContain('Detail for');
  });
});

// ---------------------------------------------------------------------------
// buildClusterSummary (from compress module)
// ---------------------------------------------------------------------------

describe('buildClusterSummary', () => {
  it('generates summary with affects and bullet points', () => {
    const cluster: Cluster = {
      id: 'c1',
      decision_ids: ['a', 'b', 'c'],
      centroid_text: 'centroid text',
      cohesion: 0.85,
      affects: ['auth', 'api'],
      size: 3,
    };

    const summaries = ['Use JWT tokens', 'Add rate limiting', 'Validate inputs'];
    const result = buildClusterSummary(cluster, summaries);

    expect(result).toContain('Pattern: 3 decisions about auth, api');
    expect(result).toContain('Key points:');
    expect(result).toContain('- Use JWT tokens');
    expect(result).toContain('- Add rate limiting');
    expect(result).toContain('- Validate inputs');
  });

  it('handles empty summaries', () => {
    const cluster: Cluster = {
      id: 'c1',
      decision_ids: ['a'],
      centroid_text: 'text',
      cohesion: 0.9,
      affects: ['database'],
      size: 1,
    };

    const result = buildClusterSummary(cluster, []);
    expect(result).toContain('(no summaries available)');
  });

  it('truncates to 10 bullet points', () => {
    const cluster: Cluster = {
      id: 'c1',
      decision_ids: Array.from({ length: 15 }, (_, i) => `d${i}`),
      centroid_text: 'text',
      cohesion: 0.8,
      affects: ['testing'],
      size: 15,
    };

    const summaries = Array.from({ length: 15 }, (_, i) => `Summary ${i}`);
    const result = buildClusterSummary(cluster, summaries);

    const bulletCount = (result.match(/^- /gm) ?? []).length;
    expect(bulletCount).toBe(10);
  });

  it('filters out empty summaries', () => {
    const cluster: Cluster = {
      id: 'c1',
      decision_ids: ['a', 'b'],
      centroid_text: 'text',
      cohesion: 0.9,
      affects: ['api'],
      size: 2,
    };

    const summaries = ['Real summary', '', ''];
    const result = buildClusterSummary(cluster, summaries);

    const bulletCount = (result.match(/^- /gm) ?? []).length;
    expect(bulletCount).toBe(1);
    expect(result).toContain('- Real summary');
  });
});
