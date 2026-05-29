/**
 * Qdrant admin — dashboard counts, legacy-point detection, the project_id
 * backfill migration, the reindex command, and the cosine similarity probe.
 *
 * Owns: ad-hoc + maintenance read/write paths usually driven by `valis admin
 * *` commands or one-off operator scripts. Hot read/write paths live in
 * sibling modules (search, decisions). Connection lifecycle is in `client.ts`.
 */

import { QdrantClient } from '@qdrant/js-client-rest';
import {
  detectEmbeddingStrategy,
  truncateForEmbedding,
  parseQuotaError,
  ClientEmbeddingStrategy,
  EmbeddingQuotaError,
  REINDEX_BATCH_SIZE,
  REINDEX_ABORT_THRESHOLD,
} from '../embedding.js';
import { COLLECTION_NAME } from './client.js';
import { buildProjectFilter } from './search.js';

/** Batch size for the Qdrant project_id backfill migration. */
const MIGRATION_BATCH_SIZE = 100;

/**
 * T027: Project-scoped dashboard stats. When projectId is provided,
 * counts only decisions in that project.
 */
export async function getDashboardStats(
  qdrant: QdrantClient,
  orgId: string,
  projectId?: string,
): Promise<{ total: number }> {
  try {
    const filter = buildProjectFilter(orgId, projectId);
    const result = await qdrant.count(COLLECTION_NAME, {
      filter,
      exact: true,
    });
    return { total: result.count };
  } catch {
    return { total: 0 };
  }
}

// ---------------------------------------------------------------------------
// Legacy point detection and counting
// ---------------------------------------------------------------------------

/**
 * Count Qdrant points for an org that do NOT have a `project_id` payload field.
 *
 * Uses the `is_null` condition to detect points where `project_id` is absent
 * or null. Returns 0 when the collection doesn't exist or on any error.
 */
export async function countLegacyPoints(
  qdrant: QdrantClient,
  orgId: string,
): Promise<number> {
  try {
    const result = await qdrant.count(COLLECTION_NAME, {
      filter: {
        must: [
          { key: 'org_id', match: { value: orgId } },
          { is_null: { key: 'project_id' } },
        ],
      },
      exact: true,
    });
    return result.count;
  } catch {
    return 0;
  }
}

/**
 * Check whether a Qdrant point is a legacy point (missing `project_id`).
 *
 * Useful for lazy backfill: when a legacy point is encountered during
 * search or upsert, the caller can set `project_id` on the fly.
 */
export function isLegacyPoint(
  payload: Record<string, unknown> | null | undefined,
): boolean {
  if (!payload) return true;
  return payload.project_id === undefined || payload.project_id === null;
}

/**
 * Backfill `project_id` on a single Qdrant point.
 *
 * Used for lazy migration: when a legacy point is encountered during
 * search results, the caller can update it with the correct project_id
 * from Postgres.
 */
export async function backfillPointProjectId(
  qdrant: QdrantClient,
  pointId: string,
  projectId: string,
): Promise<void> {
  await qdrant.setPayload(COLLECTION_NAME, {
    payload: { project_id: projectId },
    points: [pointId],
  });
}

// ---------------------------------------------------------------------------
// Background migration: backfill project_id on all legacy Qdrant points
// ---------------------------------------------------------------------------

/**
 * Report returned by `migrateQdrantProjectIds`.
 */
export interface QdrantMigrationReport {
  /** Number of points that were updated with project_id. */
  updated: number;
  /** Number of points skipped (already have project_id). */
  skipped: number;
  /** Number of points that could not be resolved (no matching Postgres decision). */
  unresolved: number;
  /** Total points scanned. */
  total: number;
}

/**
 * Iterate all Qdrant points missing `project_id` and backfill from Postgres.
 *
 * `lookupProjectId` is a callback that resolves a decision UUID to its
 * `project_id` from Postgres. The caller provides this to avoid coupling
 * the Qdrant module directly to the Supabase client.
 *
 * This can be run as a one-time CLI command (`valis admin migrate-qdrant`)
 * or called programmatically during upgrade.
 */
export async function migrateQdrantProjectIds(
  qdrant: QdrantClient,
  lookupProjectId: (decisionId: string) => Promise<string | null>,
): Promise<QdrantMigrationReport> {
  const report: QdrantMigrationReport = {
    updated: 0,
    skipped: 0,
    unresolved: 0,
    total: 0,
  };

  let offset: string | number | undefined = undefined;
  let hasMore = true;

  while (hasMore) {
    // Scroll through all points in batches. We use a filter that matches
    // points where project_id is null/missing via is_null condition.
    const scrollResult = await qdrant.scroll(COLLECTION_NAME, {
      filter: {
        must: [{ is_null: { key: 'project_id' } }],
      },
      limit: MIGRATION_BATCH_SIZE,
      with_payload: true,
      ...(offset !== undefined ? { offset } : {}),
    });

    const points = scrollResult.points;
    if (points.length === 0) {
      hasMore = false;
      break;
    }

    for (const point of points) {
      report.total++;
      const payload = point.payload as Record<string, unknown> | undefined;

      if (!isLegacyPoint(payload)) {
        report.skipped++;
        continue;
      }

      const decisionId = point.id as string;
      const projectId = await lookupProjectId(decisionId);

      if (projectId) {
        await backfillPointProjectId(qdrant, decisionId, projectId);
        report.updated++;
      } else {
        report.unresolved++;
      }
    }

    // Use the last point's ID as offset for pagination
    offset = points[points.length - 1].id;

    // If we got fewer than batch size, we've reached the end
    if (points.length < MIGRATION_BATCH_SIZE) {
      hasMore = false;
    }
  }

  return report;
}

// ---------------------------------------------------------------------------
// Reindex — backfill real embeddings into existing points (013-semantic-embeddings)
// ---------------------------------------------------------------------------

export interface ReindexOptions {
  dryRun?: boolean;
  filter?: Record<string, unknown>;
  onProgress?: (processed: number, total: number) => void;
}

export interface ReindexReport {
  total: number;        // points scanned
  reindexed: number;    // vectors successfully updated
  failed: number;       // points missing contextual_text or transient errors
  skipped: number;      // dry-run skips
  durationMs: number;
  /** Set when reindex aborts due to quota exhaustion (FR-023b). */
  quotaError?: EmbeddingQuotaError;
}

/**
 * Re-embed every Qdrant point that matches `options.filter` by reading the
 * stored `contextual_text` payload field, generating a fresh vector via the
 * active embedding strategy, and updating the point's vector in place.
 *
 * Uses `qdrant.updateVectors` (not `upsert`) so that concurrent payload
 * changes — e.g. `pinned`, `status`, cluster labels — are preserved. This
 * is FR-015 / clarification Q3: the reindex path must not clobber payload
 * fields owned by other features.
 *
 * Quota handling (FR-023b): on the first EmbeddingQuotaError we set
 * `report.quotaError` and return the partial report immediately. The CLI
 * command renders the structured error and exits non-zero so operators can
 * detect the state from CI scripts. Unlike the upsert path, reindex does
 * NOT route into the offline queue — the operator re-runs the command after
 * the quota window resets.
 */
export async function reindexAllPoints(
  qdrant: QdrantClient,
  options: ReindexOptions = {},
): Promise<ReindexReport> {
  const { dryRun = false, filter, onProgress } = options;
  const startTime = Date.now();
  const report: ReindexReport = {
    total: 0,
    reindexed: 0,
    failed: 0,
    skipped: 0,
    durationMs: 0,
  };

  const strategy = await detectEmbeddingStrategy(qdrant, COLLECTION_NAME);

  // Pre-count so onProgress can render a meaningful percentage. One extra
  // REST call per reindex run, negligible against thousands of point upserts.
  // If the count call fails, fall back to processed-only progress (the loop
  // still works; only the percentage display degrades).
  let totalEstimate = 0;
  try {
    const countResult = await qdrant.count(COLLECTION_NAME, {
      filter,
      exact: true,
    });
    totalEstimate = countResult.count;
  } catch {
    totalEstimate = 0;
  }

  let offset: string | number | undefined = undefined;
  let consecutiveErrors = 0;
  let aborted = false;

  outer: while (!aborted) {
    const scrollResult = await qdrant.scroll(COLLECTION_NAME, {
      filter,
      limit: REINDEX_BATCH_SIZE,
      with_payload: true,
      ...(offset !== undefined ? { offset } : {}),
    });

    const points = scrollResult.points;
    if (points.length === 0) {
      break;
    }

    for (const point of points) {
      report.total++;

      const payload = (point.payload ?? {}) as Record<string, unknown>;
      const contextualText = payload.contextual_text as string | undefined;

      if (!contextualText || typeof contextualText !== 'string') {
        // Legacy point without contextual_text — cannot be reindexed.
        report.failed++;
        continue;
      }

      if (dryRun) {
        report.skipped++;
        continue;
      }

      try {
        const embedInput = truncateForEmbedding(contextualText);
        const vector =
          strategy.mode === 'server'
            ? strategy.vectorForUpsert(embedInput)
            : await (strategy as ClientEmbeddingStrategy).vectorForUpsertAsync(embedInput);

        await qdrant.updateVectors(COLLECTION_NAME, {
          points: [{ id: point.id, vector: vector as never }],
        });

        report.reindexed++;
        consecutiveErrors = 0;
      } catch (err) {
        const quota = parseQuotaError(err, strategy.mode);
        if (quota) {
          report.quotaError = quota;
          aborted = true;
          break outer;
        }

        report.failed++;
        consecutiveErrors++;

        if (consecutiveErrors >= REINDEX_ABORT_THRESHOLD) {
          throw new Error(
            `Reindex aborted: ${consecutiveErrors} consecutive errors. Last error: ${(err as Error).message}`,
          );
        }
      }
    }

    // Progress callback after each batch — `total` is the pre-counted size
    // when available, otherwise falls back to the running scan count so the
    // percentage at least monotonically caps at 100%.
    onProgress?.(report.total, totalEstimate > 0 ? totalEstimate : report.total);

    // Advance the scroll cursor to the last point's id.
    offset = points[points.length - 1].id;

    // If the batch was short, no more pages — stop.
    if (points.length < REINDEX_BATCH_SIZE) {
      break;
    }
  }

  report.durationMs = Date.now() - startTime;
  return report;
}

// ---------------------------------------------------------------------------
// Cosine similarity between two decision vectors
// ---------------------------------------------------------------------------

function cosineSimilarity(a: number[], b: number[]): number {
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

/**
 * Retrieve two decision points from Qdrant and compute the cosine similarity
 * between their dense vectors.
 *
 * Returns a value in the range 0.0–1.0. Returns 0.0 when either point is not
 * found, has no vector, or has a zero-length vector.
 */
export async function getSimilarity(
  qdrant: QdrantClient,
  orgId: string,
  decisionIdA: string,
  decisionIdB: string,
): Promise<number> {
  try {
    const points = await qdrant.retrieve(COLLECTION_NAME, {
      ids: [decisionIdA, decisionIdB],
      with_vector: true,
      with_payload: true,
    });

    if (points.length < 2) return 0.0;

    // Ensure both points belong to the requested org
    const pointA = points.find((p) => p.id === decisionIdA);
    const pointB = points.find((p) => p.id === decisionIdB);
    if (!pointA || !pointB) return 0.0;

    const payloadA = pointA.payload as Record<string, unknown> | undefined;
    const payloadB = pointB.payload as Record<string, unknown> | undefined;
    if (payloadA?.org_id !== orgId || payloadB?.org_id !== orgId) return 0.0;

    // Extract dense vectors (flat number arrays)
    const vecA = pointA.vector;
    const vecB = pointB.vector;
    if (!Array.isArray(vecA) || !Array.isArray(vecB)) return 0.0;

    const similarity = cosineSimilarity(vecA as number[], vecB as number[]);
    // Clamp to [0, 1] — cosine similarity can be negative for opposed vectors
    return Math.max(0.0, Math.min(1.0, similarity));
  } catch {
    return 0.0;
  }
}

/**
 * Batch variant of {@link getSimilarity}: fetch the new decision's vector and
 * every candidate vector in a SINGLE `qdrant.retrieve` call, then compute the
 * cosine similarity of the new decision against each candidate.
 *
 * This replaces the N+1 pattern in contradiction detection where the old code
 * re-fetched the new decision's vector once per candidate. Returns a Map keyed
 * by candidate id; candidates that are missing, belong to another org, or have
 * no dense vector are mapped to `0.0`. On any error the returned map is empty
 * (caller treats absent entries as "similarity unavailable").
 */
export async function getSimilaritiesForNewDecision(
  qdrant: QdrantClient,
  orgId: string,
  newDecisionId: string,
  candidateIds: string[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (candidateIds.length === 0) return out;

  try {
    // De-dup ids and exclude the new decision id from the candidate list to
    // avoid a degenerate self-pair.
    const uniqueCandidates = Array.from(
      new Set(candidateIds.filter((id) => id !== newDecisionId)),
    );

    const points = await qdrant.retrieve(COLLECTION_NAME, {
      ids: [newDecisionId, ...uniqueCandidates],
      with_vector: true,
      with_payload: true,
    });

    const byId = new Map(points.map((p) => [String(p.id), p]));

    const newPoint = byId.get(newDecisionId);
    if (!newPoint) return out;
    const newPayload = newPoint.payload as Record<string, unknown> | undefined;
    if (newPayload?.org_id !== orgId) return out;
    const newVec = newPoint.vector;
    if (!Array.isArray(newVec)) return out;
    const newVecArr = newVec as number[];

    for (const candidateId of uniqueCandidates) {
      const point = byId.get(candidateId);
      if (!point) {
        out.set(candidateId, 0.0);
        continue;
      }
      const payload = point.payload as Record<string, unknown> | undefined;
      const vec = point.vector;
      if (payload?.org_id !== orgId || !Array.isArray(vec)) {
        out.set(candidateId, 0.0);
        continue;
      }
      const sim = cosineSimilarity(newVecArr, vec as number[]);
      out.set(candidateId, Math.max(0.0, Math.min(1.0, sim)));
    }

    return out;
  } catch {
    return new Map();
  }
}
