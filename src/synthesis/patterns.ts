/**
 * T061-T062: Pattern detection via inverted index + Jaccard similarity clustering.
 *
 * Builds an inverted index (area -> decision IDs), groups by overlapping
 * affects areas using Jaccard similarity >= 0.3, and returns clusters of
 * 3+ decisions within a configurable time window.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Decision, PatternCandidate } from '../types.js';

// ---------------------------------------------------------------------------
// Jaccard similarity (T062)
// ---------------------------------------------------------------------------

/**
 * Compute Jaccard similarity (intersection-over-union) on two string arrays.
 * Returns 0 when both arrays are empty.
 */
export function jaccard(a: string[], b: string[]): number {
  const setA = new Set(a);
  const setB = new Set(b);
  const intersection = [...setA].filter((x) => setB.has(x)).length;
  const union = new Set([...setA, ...setB]).size;
  return union === 0 ? 0 : intersection / union;
}

// ---------------------------------------------------------------------------
// Clustering helpers
// ---------------------------------------------------------------------------

/** A lightweight decision projection used during clustering. */
interface ClusterDecision {
  id: string;
  affects: string[];
  summary: string | null;
  type: string;
  created_at: string;
}

/**
 * Cluster decisions by pairwise Jaccard similarity on their `affects` arrays.
 *
 * Uses a simple single-linkage approach: start with the first unclustered
 * decision, greedily add any decision whose Jaccard similarity with *any*
 * member of the cluster is >= `threshold`.
 */
export function clusterByJaccard(
  decisions: ClusterDecision[],
  threshold: number,
): ClusterDecision[][] {
  const used = new Set<number>();
  const clusters: ClusterDecision[][] = [];

  for (let i = 0; i < decisions.length; i++) {
    if (used.has(i)) continue;

    const cluster: ClusterDecision[] = [decisions[i]];
    used.add(i);

    // Keep scanning for new members until no more can be added
    let changed = true;
    while (changed) {
      changed = false;
      for (let j = 0; j < decisions.length; j++) {
        if (used.has(j)) continue;
        // Check similarity against every member already in the cluster
        const linked = cluster.some(
          (m) => jaccard(m.affects, decisions[j].affects) >= threshold,
        );
        if (linked) {
          cluster.push(decisions[j]);
          used.add(j);
          changed = true;
        }
      }
    }

    clusters.push(cluster);
  }

  return clusters;
}

/**
 * Compute the average pairwise Jaccard similarity across a cluster of
 * decisions. Used as the cohesion metric for a PatternCandidate.
 */
export function averagePairwiseJaccard(decisions: ClusterDecision[]): number {
  if (decisions.length < 2) return 1;

  let total = 0;
  let pairs = 0;

  for (let i = 0; i < decisions.length; i++) {
    for (let j = i + 1; j < decisions.length; j++) {
      total += jaccard(decisions[i].affects, decisions[j].affects);
      pairs++;
    }
  }

  return pairs === 0 ? 0 : total / pairs;
}

/**
 * Deduplicate overlapping pattern candidates.
 *
 * If two candidates share > 80% of their decision IDs (by Jaccard on the
 * ID sets), keep the one with higher cohesion.
 */
export function deduplicatePatterns(candidates: PatternCandidate[]): PatternCandidate[] {
  const sorted = [...candidates].sort((a, b) => b.cohesion - a.cohesion);
  const kept: PatternCandidate[] = [];

  for (const candidate of sorted) {
    const isDuplicate = kept.some(
      (existing) =>
        jaccard(existing.decision_ids, candidate.decision_ids) > 0.8,
    );
    if (!isDuplicate) {
      kept.push(candidate);
    }
  }

  return kept;
}

// ---------------------------------------------------------------------------
// Main detection (T061)
// ---------------------------------------------------------------------------

export interface DetectPatternsOptions {
  /** Time window in days. Default 30. */
  windowDays?: number;
  /** Minimum decisions per cluster. Default 3. */
  minCluster?: number;
}

/**
 * Detect pattern clusters from active decisions within a time window.
 *
 * Algorithm:
 * 1. Fetch active decisions from the window.
 * 2. Build inverted index: area -> decision IDs.
 * 3. For each area with enough decisions, cluster by Jaccard >= 0.3.
 * 4. Return PatternCandidate[] (deduplicated).
 */
export async function detectPatterns(
  supabase: SupabaseClient,
  orgId: string,
  opts?: DetectPatternsOptions,
): Promise<PatternCandidate[]> {
  const windowDays = opts?.windowDays ?? 30;
  const minCluster = opts?.minCluster ?? 3;

  // 1. Fetch active decisions from the time window
  const since = new Date(Date.now() - windowDays * 86_400_000).toISOString();
  const { data: rows, error } = await supabase
    .from('decisions')
    .select('id, affects, summary, type, created_at')
    .eq('org_id', orgId)
    .eq('status', 'active')
    .gte('created_at', since);

  if (error) throw new Error(`Failed to fetch decisions for pattern detection: ${error.message}`);

  const decisions: ClusterDecision[] = (rows ?? []).map((r: Record<string, unknown>) => ({
    id: r.id as string,
    affects: (r.affects as string[]) ?? [],
    summary: (r.summary as string) ?? null,
    type: (r.type as string) ?? 'pending',
    created_at: r.created_at as string,
  }));

  if (decisions.length < minCluster) return [];

  // 2. Build inverted index: area -> decision IDs
  const areaIndex = new Map<string, string[]>();
  for (const d of decisions) {
    for (const area of d.affects) {
      const ids = areaIndex.get(area) ?? [];
      ids.push(d.id);
      areaIndex.set(area, ids);
    }
  }

  // 3. Find areas with enough decisions and cluster
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

  // 4. Deduplicate overlapping candidates
  return deduplicatePatterns(candidates);
}
