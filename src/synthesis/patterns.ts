/**
 * T061-T062: Pattern detection via affects-area overlap + Jaccard similarity.
 *
 * Algorithm:
 * 1. Build inverted index: area -> decision IDs
 * 2. For each area with >= minCluster decisions, cluster by Jaccard on full affects arrays
 * 3. Average pairwise Jaccard as cohesion metric
 * 4. Deduplicate overlapping pattern candidates
 */

import type { Decision, PatternCandidate } from '../types.js';

// ---------------------------------------------------------------------------
// Jaccard similarity (T062)
// ---------------------------------------------------------------------------

/**
 * Compute Jaccard similarity (intersection-over-union) on two string arrays.
 * Returns 0 when both are empty.
 */
export function jaccard(a: string[], b: string[]): number {
  const setA = new Set(a);
  const setB = new Set(b);
  const intersection = [...setA].filter((x) => setB.has(x)).length;
  const union = new Set([...setA, ...setB]).size;
  return union === 0 ? 0 : intersection / union;
}

// ---------------------------------------------------------------------------
// Clustering (T061)
// ---------------------------------------------------------------------------

/** Minimal decision shape needed by the clustering algorithm. */
export interface ClusterDecision {
  id: string;
  affects: string[];
  summary: string | null;
  type: string;
  created_at: string;
}

/**
 * Single-linkage clustering by Jaccard similarity on `affects` arrays.
 *
 * Two decisions are considered related when their Jaccard >= `threshold`.
 * Returns an array of clusters (each cluster = array of decisions).
 */
export function clusterByJaccard(
  decisions: ClusterDecision[],
  threshold: number,
): ClusterDecision[][] {
  // Union-Find for clustering
  const parent = new Map<number, number>();
  const find = (i: number): number => {
    if (!parent.has(i)) parent.set(i, i);
    if (parent.get(i) !== i) parent.set(i, find(parent.get(i)!));
    return parent.get(i)!;
  };
  const unite = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };

  // Initialize
  for (let i = 0; i < decisions.length; i++) {
    parent.set(i, i);
  }

  // Pairwise Jaccard — unite when above threshold
  for (let i = 0; i < decisions.length; i++) {
    for (let j = i + 1; j < decisions.length; j++) {
      const sim = jaccard(decisions[i].affects, decisions[j].affects);
      if (sim >= threshold) {
        unite(i, j);
      }
    }
  }

  // Collect clusters
  const clusters = new Map<number, ClusterDecision[]>();
  for (let i = 0; i < decisions.length; i++) {
    const root = find(i);
    if (!clusters.has(root)) clusters.set(root, []);
    clusters.get(root)!.push(decisions[i]);
  }

  return [...clusters.values()];
}

/**
 * Compute average pairwise Jaccard similarity across a cluster of decisions.
 * Returns 0 for clusters with fewer than 2 decisions.
 */
export function averagePairwiseJaccard(cluster: ClusterDecision[]): number {
  if (cluster.length < 2) return 0;

  let sum = 0;
  let count = 0;
  for (let i = 0; i < cluster.length; i++) {
    for (let j = i + 1; j < cluster.length; j++) {
      sum += jaccard(cluster[i].affects, cluster[j].affects);
      count++;
    }
  }
  return count > 0 ? sum / count : 0;
}

// ---------------------------------------------------------------------------
// Pattern detection (T061)
// ---------------------------------------------------------------------------

/**
 * Deduplicate pattern candidates that share >80% of their decision IDs.
 * Keeps the candidate with higher cohesion.
 */
export function deduplicatePatterns(
  candidates: PatternCandidate[],
): PatternCandidate[] {
  // Sort by cohesion descending so we keep the best candidates
  const sorted = [...candidates].sort((a, b) => b.cohesion - a.cohesion);
  const kept: PatternCandidate[] = [];

  for (const candidate of sorted) {
    const candidateIds = candidate.decision_ids;
    const isDuplicate = kept.some((existing) => {
      const overlap = jaccard(candidateIds, existing.decision_ids);
      return overlap > 0.8;
    });

    if (!isDuplicate) {
      kept.push(candidate);
    }
  }

  return kept;
}

/**
 * Detect pattern candidates from a set of active decisions within a time window.
 *
 * Steps:
 * 1. Build inverted index (area -> decision IDs)
 * 2. For each area with >= minCluster decisions, run Jaccard clustering
 * 3. Filter clusters >= minCluster, compute cohesion and summary
 * 4. Deduplicate overlapping candidates
 */
export function detectPatterns(
  decisions: ClusterDecision[],
  minCluster: number,
  windowDays: number,
): PatternCandidate[] {
  // 1. Build inverted index: area -> decision IDs
  const areaIndex = new Map<string, string[]>();
  for (const d of decisions) {
    for (const area of d.affects) {
      const ids = areaIndex.get(area) ?? [];
      ids.push(d.id);
      areaIndex.set(area, ids);
    }
  }

  // 2. Find areas with enough decisions and cluster
  const candidates: PatternCandidate[] = [];
  for (const [area, ids] of areaIndex) {
    if (ids.length < minCluster) continue;

    const clusterDecisions = ids.map(
      (id) => decisions.find((d) => d.id === id)!,
    );
    const clusters = clusterByJaccard(clusterDecisions, 0.3);

    for (const cluster of clusters) {
      if (cluster.length < minCluster) continue;

      const unionAreas = [...new Set(cluster.flatMap((d) => d.affects))];
      const avgCohesion = averagePairwiseJaccard(cluster);

      candidates.push({
        affects: unionAreas,
        decision_ids: cluster.map((d) => d.id),
        cohesion: avgCohesion,
        already_exists: false,
      });
    }
  }

  // 3. Deduplicate overlapping candidates
  return deduplicatePatterns(candidates);
}

/**
 * Generate a human-readable summary for a pattern candidate.
 */
export function patternSummary(
  areas: string[],
  clusterSize: number,
  windowDays: number,
): string {
  return `Team pattern: ${areas.join(', ')} — ${clusterSize} decisions in ${windowDays} days`;
}
