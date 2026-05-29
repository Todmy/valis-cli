/**
 * 032/Track 6 — metadata-only Qdrant scroll for `query_mode: "metadata_only"`.
 *
 * Bypasses vector search entirely. Composes the project-scope predicate
 * (org_id + optional project_id) with the structured filter from
 * `SearchFilterBuilder`, calls `qdrant.scroll` for a paginated payload-only
 * scan, and returns rows mapped into the existing `RerankedResult` shape so
 * the caller can return them through the standard `SearchResponse` envelope.
 *
 * Returns ordered by `created_at` descending — the spec's "newest first"
 * default for predicate-only workloads. The first 1000 rows from the scroll
 * are taken and sorted in memory to keep this implementation deterministic
 * across Qdrant versions; production volume is well under that.
 */

import type { QdrantClient } from '@qdrant/js-client-rest';
import { COLLECTION_NAME } from './client.js';
import type {
  RerankedResult,
  SignalValues,
  DecisionType,
  DecisionStatus,
  DecisionSource,
} from '../../types.js';
import type { SearchFilter } from '../../search/filter-builder.js';

interface ScrollOptions {
  orgId: string;
  /** Project UUID — composed into the project-scope predicate when present. */
  projectId?: string;
  filter: SearchFilter;
  limit: number;
}

const SCROLL_OVERFETCH = 1000;

const ZERO_SIGNALS: SignalValues = {
  semantic_score: 0,
  bm25_score: 0,
  recency_decay: 0,
  importance: 0,
  graph_connectivity: 0,
  cluster_boost: 0,
};

/**
 * Execute a payload-only scroll over `decisions`. Always emits the
 * project-scope predicate (org_id + optional project_id) so cross-org leakage
 * is impossible regardless of caller filters.
 */
export async function metadataOnlyScroll(
  qdrant: QdrantClient,
  opts: ScrollOptions,
): Promise<RerankedResult[]> {
  // Compose project-scope predicate with caller-supplied filter. The scope
  // predicate is non-negotiable — any filter the agent passes is AND-ed on top.
  const scopeMust: Array<Record<string, unknown>> = [
    { key: 'org_id', match: { value: opts.orgId } },
  ];
  if (opts.projectId) {
    scopeMust.push({ key: 'project_id', match: { value: opts.projectId } });
  }
  const composedFilter = {
    must: [...scopeMust, ...opts.filter.must],
  };

  const response = await qdrant.scroll(COLLECTION_NAME, {
    filter: composedFilter as never,
    limit: SCROLL_OVERFETCH,
    with_payload: true,
    with_vector: false,
  });

  const points = response.points ?? [];

  // Map raw points → RerankedResult shape with zeroed signals (no vector
  // scoring happened) and dedup by decision_id (a single decision may live
  // as N chunk points sharing the same id; keep the first occurrence).
  const seen = new Set<string>();
  const mapped: RerankedResult[] = [];
  for (const p of points) {
    const payload = (p.payload ?? {}) as Record<string, unknown>;
    const parentId = (payload.decision_id as string) ?? String(p.id);
    if (seen.has(parentId)) continue;
    seen.add(parentId);

    mapped.push({
      id: parentId,
      score: 0,
      type: (payload.type as DecisionType) ?? 'decision',
      summary: (payload.summary as string) ?? null,
      detail: (payload.detail as string) ?? '',
      author: (payload.author as string) ?? '',
      affects: (payload.affects as string[]) ?? [],
      created_at: (payload.created_at as string) ?? new Date(0).toISOString(),
      // 036 (#90): post-fix points always carry their real status; this
      // `?? 'active'` fallback now only covers legacy pre-036 Qdrant points.
      status: (payload.status as DecisionStatus) ?? 'active',
      confidence: (payload.confidence as number) ?? null,
      pinned: (payload.pinned as boolean) ?? false,
      depends_on: (payload.depends_on as string[]) ?? [],
      outcome:
        (payload.outcome as 'success' | 'failed' | 'partial' | 'unknown') ??
        'unknown',
      project_id: (payload.project_id as string) ?? undefined,
      source: (payload.source as DecisionSource) ?? undefined,
      composite_score: 0,
      signals: ZERO_SIGNALS,
    });
  }

  // FR-002 / Acceptance Scenario 1 — sort by created_at desc, then trim.
  mapped.sort((a, b) => {
    const aMs = Date.parse(a.created_at);
    const bMs = Date.parse(b.created_at);
    return bMs - aMs;
  });
  return mapped.slice(0, opts.limit);
}
