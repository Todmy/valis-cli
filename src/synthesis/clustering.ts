/**
 * Time-windowed decision clustering using cosine similarity.
 *
 * Density-based clustering (simplified DBSCAN) on decision vectors stored in
 * Qdrant. Groups semantically similar decisions into clusters for knowledge
 * compression.
 *
 * Algorithm:
 *   1. Scroll all active decisions for an org from Qdrant (with vectors).
 *   2. Optionally filter by time window.
 *   3. Build pairwise cosine similarity matrix.
 *   4. Find neighbors within `similarityThreshold` for each decision.
 *   5. Group connected components via Union-Find.
 *   6. Filter clusters by `minClusterSize`.
 *   7. Compute centroid (decision closest to cluster center).
 *
 * @module synthesis/clustering
 */

import type { QdrantClient } from '@qdrant/js-client-rest';
import { COLLECTION_NAME } from '../cloud/qdrant.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Cluster {
  id: string;
  decision_ids: string[];
  centroid_text: string;
  cohesion: number;
  affects: string[];
  size: number;
}

/** Point representation used by the clustering algorithm. */
export interface VectorPoint {
  id: string;
  vector: number[];
  detail: string;
  summary: string | null;
  affects: string[];
  created_at: string;
}

// ---------------------------------------------------------------------------
// Cosine similarity (local copy — the one in qdrant.ts is private)
// ---------------------------------------------------------------------------

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0.0;

  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  if (normA === 0 || normB === 0) return 0.0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// ---------------------------------------------------------------------------
// Union-Find
// ---------------------------------------------------------------------------

function makeUnionFind(size: number) {
  const parent = new Array<number>(size);
  for (let i = 0; i < size; i++) parent[i] = i;

  const find = (i: number): number => {
    if (parent[i] !== i) parent[i] = find(parent[i]);
    return parent[i];
  };

  const unite = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };

  return { find, unite };
}

// ---------------------------------------------------------------------------
// Fetch decision vectors from Qdrant
// ---------------------------------------------------------------------------

const SCROLL_BATCH = 100;

async function fetchDecisionVectors(
  qdrant: QdrantClient,
  orgId: string,
  timeWindowDays?: number,
): Promise<VectorPoint[]> {
  const points: VectorPoint[] = [];
  let offset: string | number | undefined = undefined;
  let hasMore = true;

  const cutoff = timeWindowDays
    ? new Date(Date.now() - timeWindowDays * 86_400_000).toISOString()
    : undefined;

  while (hasMore) {
    const scrollResult = await qdrant.scroll(COLLECTION_NAME, {
      filter: {
        must: [
          { key: 'org_id', match: { value: orgId } },
          { key: 'status', match: { value: 'active' } },
        ],
      },
      limit: SCROLL_BATCH,
      with_payload: true,
      with_vector: true,
      ...(offset !== undefined ? { offset } : {}),
    });

    for (const p of scrollResult.points) {
      const payload = (p.payload ?? {}) as Record<string, unknown>;
      const createdAt = (payload.created_at as string) ?? '';

      // Time window filter
      if (cutoff && createdAt < cutoff) continue;

      // Extract dense vector
      const vec = p.vector;
      if (!Array.isArray(vec)) continue;

      // Skip zero vectors (placeholder upserts without server-side embeddings)
      const isZero = (vec as number[]).every((v) => v === 0);
      if (isZero) continue;

      points.push({
        id: p.id as string,
        vector: vec as number[],
        detail: (payload.detail as string) ?? '',
        summary: (payload.summary as string) ?? null,
        affects: (payload.affects as string[]) ?? [],
        created_at: createdAt,
      });
    }

    if (scrollResult.points.length < SCROLL_BATCH) {
      hasMore = false;
    } else {
      offset = scrollResult.points[scrollResult.points.length - 1].id;
    }
  }

  return points;
}

// ---------------------------------------------------------------------------
// Clustering algorithm
// ---------------------------------------------------------------------------

/**
 * Build similarity matrix and group connected components using simplified
 * DBSCAN (without core/border point distinction).
 */
export function clusterPoints(
  points: VectorPoint[],
  similarityThreshold: number,
  minClusterSize: number,
): Cluster[] {
  if (points.length === 0) return [];

  const n = points.length;
  const uf = makeUnionFind(n);

  // Build similarity matrix and unite neighbors above threshold
  const simMatrix: number[][] = Array.from({ length: n }, () =>
    new Array<number>(n).fill(0),
  );

  for (let i = 0; i < n; i++) {
    simMatrix[i][i] = 1.0;
    for (let j = i + 1; j < n; j++) {
      const sim = cosineSimilarity(points[i].vector, points[j].vector);
      const clamped = Math.max(0.0, Math.min(1.0, sim));
      simMatrix[i][j] = clamped;
      simMatrix[j][i] = clamped;

      if (clamped >= similarityThreshold) {
        uf.unite(i, j);
      }
    }
  }

  // Collect clusters
  const groups = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const root = uf.find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root)!.push(i);
  }

  // Filter by minimum size, compute centroid and cohesion
  const clusters: Cluster[] = [];

  for (const [, indices] of groups) {
    if (indices.length < minClusterSize) continue;

    // Compute average intra-cluster similarity (cohesion)
    let simSum = 0;
    let pairCount = 0;
    for (let i = 0; i < indices.length; i++) {
      for (let j = i + 1; j < indices.length; j++) {
        simSum += simMatrix[indices[i]][indices[j]];
        pairCount++;
      }
    }
    const cohesion = pairCount > 0 ? simSum / pairCount : 0;

    // Find centroid: the point with the highest average similarity to all
    // other points in the cluster
    let centroidIdx = indices[0];
    let bestAvg = -1;
    for (const idx of indices) {
      let avg = 0;
      for (const other of indices) {
        if (idx !== other) avg += simMatrix[idx][other];
      }
      avg /= indices.length - 1;
      if (avg > bestAvg) {
        bestAvg = avg;
        centroidIdx = idx;
      }
    }

    const centroidPoint = points[centroidIdx];
    const decisionIds = indices.map((i) => points[i].id);
    const unionAffects = [...new Set(indices.flatMap((i) => points[i].affects))];

    clusters.push({
      id: centroidPoint.id,
      decision_ids: decisionIds,
      centroid_text: centroidPoint.summary ?? centroidPoint.detail.slice(0, 200),
      cohesion,
      affects: unionAffects,
      size: indices.length,
    });
  }

  // Sort by size descending
  clusters.sort((a, b) => b.size - a.size);

  return clusters;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ClusterOptions {
  minClusterSize?: number;
  similarityThreshold?: number;
  timeWindowDays?: number;
}

/**
 * Cluster active decisions for an org by semantic similarity.
 *
 * Fetches vectors from Qdrant, builds a pairwise similarity matrix, and
 * groups connected components above the threshold using Union-Find.
 */
export async function clusterDecisions(
  qdrant: QdrantClient,
  orgId: string,
  options: ClusterOptions = {},
): Promise<Cluster[]> {
  const {
    minClusterSize = 3,
    similarityThreshold = 0.75,
    timeWindowDays,
  } = options;

  const points = await fetchDecisionVectors(qdrant, orgId, timeWindowDays);
  return clusterPoints(points, similarityThreshold, minClusterSize);
}
