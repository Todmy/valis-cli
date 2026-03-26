/**
 * Knowledge compression — merge decision clusters into pattern decisions.
 *
 * For each cluster identified by `clusterDecisions`, creates a summary
 * pattern decision and links the originals via `grouped_by` payload field.
 * Original decisions are NOT deleted — they remain searchable, but the
 * pattern ranks higher due to its composite nature.
 *
 * @module synthesis/compress
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { QdrantClient } from '@qdrant/js-client-rest';
import type { Decision } from '../types.js';
import type { Cluster } from './clustering.js';
import { storeDecision } from '../cloud/supabase.js';
import { COLLECTION_NAME } from '../cloud/qdrant.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CompressionReport {
  mode: 'dry_run' | 'applied';
  clusters_found: number;
  patterns_created: number;
  decisions_grouped: number;
  clusters: Array<{
    id: string;
    size: number;
    cohesion: number;
    affects: string[];
    centroid_text: string;
    pattern_id?: string;
  }>;
  errors: Array<{ cluster_id: string; error: string }>;
}

// ---------------------------------------------------------------------------
// Summary generation
// ---------------------------------------------------------------------------

/**
 * Build a human-readable summary for a compressed cluster.
 *
 * Uses a deterministic template — no LLM needed.
 */
export function buildClusterSummary(
  cluster: Cluster,
  summaries: string[],
): string {
  const areasStr = cluster.affects.join(', ');
  const bulletPoints = summaries
    .filter(Boolean)
    .slice(0, 10)
    .map((s) => `- ${s}`)
    .join('\n');

  return (
    `Pattern: ${cluster.size} decisions about ${areasStr}.\n` +
    `Key points:\n${bulletPoints || '- (no summaries available)'}`
  );
}

// ---------------------------------------------------------------------------
// Compress a single cluster
// ---------------------------------------------------------------------------

/**
 * Create a pattern decision from a cluster and mark originals with
 * `grouped_by` in Qdrant payload.
 */
export async function compressCluster(
  supabase: SupabaseClient,
  qdrant: QdrantClient,
  cluster: Cluster,
  orgId: string,
): Promise<Decision> {
  // Fetch summaries of all decisions in the cluster from Postgres
  const { data: decisions, error: fetchError } = await supabase
    .from('decisions')
    .select('id, summary, detail')
    .in('id', cluster.decision_ids)
    .eq('org_id', orgId);

  if (fetchError) {
    throw new Error(`Failed to fetch cluster decisions: ${fetchError.message}`);
  }

  const summaries = (decisions ?? []).map(
    (d: { summary: string | null; detail: string }) =>
      d.summary ?? d.detail.slice(0, 120),
  );

  const summaryText = buildClusterSummary(cluster, summaries);

  // Store as a new pattern decision
  const patternDecision = await storeDecision(
    supabase,
    orgId,
    {
      text: summaryText,
      type: 'pattern',
      summary: `Cluster: ${cluster.affects.slice(0, 5).join(', ')} (${cluster.size} decisions)`,
      affects: cluster.affects,
      confidence: cluster.cohesion,
    },
    'system',
    'synthesis',
    { depends_on: cluster.decision_ids },
  );

  // Mark originals with grouped_by in Qdrant payload (best-effort)
  for (const decisionId of cluster.decision_ids) {
    try {
      await qdrant.setPayload(COLLECTION_NAME, {
        payload: { grouped_by: patternDecision.id },
        points: [decisionId],
      });
    } catch {
      // Non-fatal — Qdrant payload update failures don't block compression
    }
  }

  return patternDecision;
}

// ---------------------------------------------------------------------------
// Batch compression
// ---------------------------------------------------------------------------

/**
 * Compress multiple clusters. In dry-run mode, only reports what would happen.
 */
export async function compressClusters(
  supabase: SupabaseClient,
  qdrant: QdrantClient,
  clusters: Cluster[],
  orgId: string,
  dryRun: boolean,
): Promise<CompressionReport> {
  const report: CompressionReport = {
    mode: dryRun ? 'dry_run' : 'applied',
    clusters_found: clusters.length,
    patterns_created: 0,
    decisions_grouped: 0,
    clusters: [],
    errors: [],
  };

  for (const cluster of clusters) {
    const entry = {
      id: cluster.id,
      size: cluster.size,
      cohesion: cluster.cohesion,
      affects: cluster.affects,
      centroid_text: cluster.centroid_text,
      pattern_id: undefined as string | undefined,
    };

    if (dryRun) {
      report.clusters.push(entry);
      continue;
    }

    try {
      const pattern = await compressCluster(supabase, qdrant, cluster, orgId);
      entry.pattern_id = pattern.id;
      report.clusters.push(entry);
      report.patterns_created++;
      report.decisions_grouped += cluster.size;
    } catch (err) {
      report.errors.push({
        cluster_id: cluster.id,
        error: err instanceof Error ? err.message : String(err),
      });
      report.clusters.push(entry);
    }
  }

  return report;
}
