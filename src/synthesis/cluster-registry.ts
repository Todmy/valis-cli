/**
 * Incremental on-store clustering via a lightweight cluster registry.
 *
 * Cluster assignments are stored in the Qdrant payload (`cluster_id` field)
 * on each decision point. The ClusterRegistry provides methods to assign
 * new decisions to clusters, list clusters, merge clusters, and retrieve
 * cluster members.
 *
 * Clustering uses vector similarity (cosine distance) from Qdrant's query
 * endpoint rather than the affects-based Jaccard clustering in patterns.ts.
 */

import type { QdrantClient } from '@qdrant/js-client-rest';
import { COLLECTION_NAME } from '../cloud/qdrant.js';
import type { Decision } from '../types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ClusterInfo {
  id: string;
  label: string;
  representative_id: string;  // decision closest to centroid
  member_count: number;
  affects: string[];
  avg_similarity: number;
  last_updated: string;
}

/** Minimum similarity to join an existing cluster. */
export const CLUSTER_SIMILARITY_THRESHOLD = 0.75;

/** Minimum singletons required to form a new cluster. */
export const MIN_SINGLETONS_FOR_CLUSTER = 3;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Generate a deterministic cluster ID from the representative decision. */
function generateClusterId(representativeId: string): string {
  return `cluster_${representativeId.slice(0, 12)}`;
}

/** Union of all affects arrays, deduplicated. */
function unionAffects(arrays: string[][]): string[] {
  return [...new Set(arrays.flat())];
}

// ---------------------------------------------------------------------------
// ClusterRegistry
// ---------------------------------------------------------------------------

export class ClusterRegistry {
  constructor(
    private qdrant: QdrantClient,
    private orgId: string,
  ) {}

  /**
   * Find which cluster a new decision belongs to, or create a new one
   * if enough singletons are mutually similar.
   *
   * Algorithm:
   * 1. Query Qdrant for top-5 most similar existing decisions (same org).
   * 2. If best match has similarity > threshold AND has a cluster_id:
   *    - Assign decision to that cluster, update stats.
   * 3. If no match > threshold: leave as singleton.
   * 4. Check if 3+ singletons (including this one) are mutually similar.
   *    If so, form a new cluster.
   */
  async assignCluster(
    decisionId: string,
    detail: string,
    affects: string[],
  ): Promise<ClusterInfo | null> {
    // 1. Search for top-5 similar decisions
    const similar = await this.findSimilar(decisionId, detail, 5);

    if (similar.length === 0) return null;

    // 2. Check if best match has a cluster and is above threshold
    const bestMatch = similar[0];
    if (
      bestMatch.score >= CLUSTER_SIMILARITY_THRESHOLD &&
      bestMatch.cluster_id
    ) {
      // Assign to existing cluster
      await this.setClusterId(decisionId, bestMatch.cluster_id);

      // Update cluster stats
      return this.refreshClusterInfo(bestMatch.cluster_id);
    }

    // 3. No good cluster match — check for singleton coalescence
    if (bestMatch.score >= CLUSTER_SIMILARITY_THRESHOLD) {
      // The best match has no cluster either. Check if we can form one.
      const singletons = similar.filter(
        (s) => s.score >= CLUSTER_SIMILARITY_THRESHOLD && !s.cluster_id,
      );

      if (singletons.length >= MIN_SINGLETONS_FOR_CLUSTER - 1) {
        // We have enough singletons (including the new decision) to form a cluster
        const memberIds = [
          decisionId,
          ...singletons.slice(0, MIN_SINGLETONS_FOR_CLUSTER - 1).map((s) => s.id),
        ];
        const memberAffects = [
          affects,
          ...singletons.slice(0, MIN_SINGLETONS_FOR_CLUSTER - 1).map((s) => s.affects),
        ];

        // Use the first singleton as representative (it's the most similar)
        const representativeId = decisionId;
        const clusterId = generateClusterId(representativeId);

        // Compute average similarity among members
        const scores = singletons
          .slice(0, MIN_SINGLETONS_FOR_CLUSTER - 1)
          .map((s) => s.score);
        const avgSimilarity =
          scores.length > 0
            ? scores.reduce((a, b) => a + b, 0) / scores.length
            : 0;

        // Set cluster_id on all members
        for (const id of memberIds) {
          await this.setClusterId(id, clusterId);
        }

        const clusterInfo: ClusterInfo = {
          id: clusterId,
          label: `Cluster: ${unionAffects(memberAffects).slice(0, 3).join(', ')}`,
          representative_id: representativeId,
          member_count: memberIds.length,
          affects: unionAffects(memberAffects),
          avg_similarity: avgSimilarity,
          last_updated: new Date().toISOString(),
        };

        return clusterInfo;
      }
    }

    // 4. Not enough similar decisions — remain singleton
    return null;
  }

  /**
   * List all clusters for the org by scanning unique cluster_id values.
   */
  async listClusters(): Promise<ClusterInfo[]> {
    const clusterMap = new Map<string, {
      ids: string[];
      affects: string[][];
      scores: number[];
    }>();

    let offset: string | number | undefined = undefined;
    let hasMore = true;

    while (hasMore) {
      const result = await this.qdrant.scroll(COLLECTION_NAME, {
        filter: {
          must: [
            { key: 'org_id', match: { value: this.orgId } },
          ],
          must_not: [
            { is_null: { key: 'cluster_id' } },
          ],
        },
        limit: 100,
        with_payload: true,
        ...(offset !== undefined ? { offset } : {}),
      });

      for (const point of result.points) {
        const payload = point.payload as Record<string, unknown> | undefined;
        if (!payload?.cluster_id) continue;

        const clusterId = payload.cluster_id as string;
        if (!clusterMap.has(clusterId)) {
          clusterMap.set(clusterId, { ids: [], affects: [], scores: [] });
        }

        const entry = clusterMap.get(clusterId)!;
        entry.ids.push(point.id as string);
        entry.affects.push((payload.affects as string[]) ?? []);
      }

      if (result.points.length < 100) {
        hasMore = false;
      } else {
        offset = result.points[result.points.length - 1].id;
      }
    }

    // Build ClusterInfo for each cluster
    const clusters: ClusterInfo[] = [];
    for (const [clusterId, data] of clusterMap) {
      clusters.push({
        id: clusterId,
        label: `Cluster: ${unionAffects(data.affects).slice(0, 3).join(', ')}`,
        representative_id: data.ids[0],
        member_count: data.ids.length,
        affects: unionAffects(data.affects),
        avg_similarity: 0, // Would need vector retrieval to compute; skip for listing
        last_updated: new Date().toISOString(),
      });
    }

    return clusters.sort((a, b) => b.member_count - a.member_count);
  }

  /**
   * Merge two clusters by reassigning all members of cluster B to cluster A.
   */
  async mergeClusters(aId: string, bId: string): Promise<ClusterInfo> {
    // Get members of cluster B
    const bMembers = await this.getMemberIds(bId);

    // Reassign all B members to A
    for (const memberId of bMembers) {
      await this.setClusterId(memberId, aId);
    }

    // Refresh A's info
    return this.refreshClusterInfo(aId);
  }

  /**
   * Get all decisions belonging to a cluster.
   */
  async getMembers(clusterId: string): Promise<Decision[]> {
    const members: Decision[] = [];
    let offset: string | number | undefined = undefined;
    let hasMore = true;

    while (hasMore) {
      const result = await this.qdrant.scroll(COLLECTION_NAME, {
        filter: {
          must: [
            { key: 'org_id', match: { value: this.orgId } },
            { key: 'cluster_id', match: { value: clusterId } },
          ],
        },
        limit: 100,
        with_payload: true,
        ...(offset !== undefined ? { offset } : {}),
      });

      for (const point of result.points) {
        const payload = (point.payload ?? {}) as Record<string, unknown>;
        members.push({
          id: point.id as string,
          org_id: payload.org_id as string,
          type: (payload.type as Decision['type']) ?? 'pending',
          summary: (payload.summary as string) ?? null,
          detail: (payload.detail as string) ?? '',
          status: (payload.status as Decision['status']) ?? 'active',
          author: (payload.author as string) ?? '',
          source: (payload.source as Decision['source']) ?? 'mcp_store',
          project_id: (payload.project_id as string) ?? '',
          session_id: (payload.session_id as string) ?? null,
          content_hash: '',
          confidence: (payload.confidence as number) ?? null,
          affects: (payload.affects as string[]) ?? [],
          created_at: (payload.created_at as string) ?? '',
          updated_at: (payload.created_at as string) ?? '',
        });
      }

      if (result.points.length < 100) {
        hasMore = false;
      } else {
        offset = result.points[result.points.length - 1].id;
      }
    }

    return members;
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  /**
   * Find similar decisions using Qdrant query search.
   * Returns scored results with their cluster_id and affects from payload.
   */
  private async findSimilar(
    decisionId: string,
    detail: string,
    limit: number,
  ): Promise<Array<{ id: string; score: number; cluster_id: string | null; affects: string[] }>> {
    try {
      const results = await this.qdrant.query(COLLECTION_NAME, {
        query: detail,
        filter: {
          must: [
            { key: 'org_id', match: { value: this.orgId } },
          ],
          must_not: [
            { has_id: [decisionId] },
          ],
        },
        limit,
        with_payload: true,
      });

      return results.points.map((point) => {
        const payload = (point.payload ?? {}) as Record<string, unknown>;
        return {
          id: point.id as string,
          score: point.score ?? 0,
          cluster_id: (payload.cluster_id as string) ?? null,
          affects: (payload.affects as string[]) ?? [],
        };
      });
    } catch {
      // Query search unavailable (no server-side embeddings) — return empty
      return [];
    }
  }

  /** Set cluster_id on a Qdrant point. */
  private async setClusterId(
    decisionId: string,
    clusterId: string,
  ): Promise<void> {
    await this.qdrant.setPayload(COLLECTION_NAME, {
      payload: { cluster_id: clusterId },
      points: [decisionId],
    });
  }

  /** Get member IDs for a cluster. */
  private async getMemberIds(clusterId: string): Promise<string[]> {
    const ids: string[] = [];
    let offset: string | number | undefined = undefined;
    let hasMore = true;

    while (hasMore) {
      const result = await this.qdrant.scroll(COLLECTION_NAME, {
        filter: {
          must: [
            { key: 'org_id', match: { value: this.orgId } },
            { key: 'cluster_id', match: { value: clusterId } },
          ],
        },
        limit: 100,
        with_payload: false,
        ...(offset !== undefined ? { offset } : {}),
      });

      for (const point of result.points) {
        ids.push(point.id as string);
      }

      if (result.points.length < 100) {
        hasMore = false;
      } else {
        offset = result.points[result.points.length - 1].id;
      }
    }

    return ids;
  }

  /** Recompute cluster info from current members. */
  private async refreshClusterInfo(clusterId: string): Promise<ClusterInfo> {
    const members = await this.getMembers(clusterId);
    const allAffects = members.map((m) => m.affects);

    return {
      id: clusterId,
      label: `Cluster: ${unionAffects(allAffects).slice(0, 3).join(', ')}`,
      representative_id: members[0]?.id ?? '',
      member_count: members.length,
      affects: unionAffects(allAffects),
      avg_similarity: 0, // Requires vector retrieval; omitted for performance
      last_updated: new Date().toISOString(),
    };
  }
}
