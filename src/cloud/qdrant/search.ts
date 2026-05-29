/**
 * Qdrant search — hybrid query, filter builders, query expansion, and chunk
 * enrichment (siblings / full-detail).
 *
 * Owns: read-path that surfaces SearchResults. Decision CRUD, admin migration,
 * and connection lifecycle sit in sibling modules.
 */

import { QdrantClient } from '@qdrant/js-client-rest';
import type {
  SearchResult,
  DecisionType,
  DecisionStatus,
  DecisionSource,
  SearchExpand,
} from '../../types.js';
import {
  detectEmbeddingStrategy,
  truncateForEmbedding,
  parseQuotaError,
  ClientEmbeddingStrategy,
  DENSE_VECTOR_NAME,
  BM25_VECTOR_NAME,
} from '../embedding.js';
import { COLLECTION_NAME } from './client.js';

// ---------------------------------------------------------------------------
// Project-aware filter builders (backward compatible with legacy points)
// ---------------------------------------------------------------------------

/**
 * Build a Qdrant filter clause for project-scoped queries.
 *
 * During migration, some points may not have `project_id` in their payload.
 * This builder produces a `should` clause that matches either:
 *   1. Points with the correct `project_id`, OR
 *   2. Points where `project_id` is missing (legacy points).
 *
 * Once migration is complete, callers can switch to strict mode by passing
 * `{ legacyFallback: false }`.
 */
export function buildProjectFilter(
  orgId: string,
  projectId?: string,
  options?: { type?: string; legacyFallback?: boolean },
): Record<string, unknown> {
  const mustClauses: Record<string, unknown>[] = [
    { key: 'org_id', match: { value: orgId } },
  ];

  if (options?.type) {
    mustClauses.push({ key: 'type', match: { value: options.type } });
  }

  // When no projectId is provided, return org-scoped filter (cross-project / legacy)
  if (!projectId) {
    return { must: mustClauses };
  }

  const useFallback = options?.legacyFallback ?? true;

  if (useFallback) {
    // Match project_id OR missing project_id (legacy points without the field).
    // Qdrant's IsNull condition matches points where the field does not exist
    // or is explicitly null.
    mustClauses.push({
      should: [
        { key: 'project_id', match: { value: projectId } },
        { is_null: { key: 'project_id' } },
      ],
    });
  } else {
    mustClauses.push({ key: 'project_id', match: { value: projectId } });
  }

  return { must: mustClauses };
}

/**
 * Build a Qdrant filter for cross-project (--all-projects) search.
 *
 * Accepts an array of project IDs the member has access to and builds a
 * `should` clause so results from any accessible project are returned.
 * Also includes legacy points (missing project_id) via fallback.
 */
export function buildAllProjectsFilter(
  orgId: string,
  projectIds: string[],
  options?: { type?: string },
): Record<string, unknown> {
  const mustClauses: Record<string, unknown>[] = [
    { key: 'org_id', match: { value: orgId } },
  ];

  if (options?.type) {
    mustClauses.push({ key: 'type', match: { value: options.type } });
  }

  if (projectIds.length > 0) {
    // Use match.any for multi-value matching + is_null for legacy points
    mustClauses.push({
      should: [
        { key: 'project_id', match: { any: projectIds } },
        { is_null: { key: 'project_id' } },
      ],
    });
  }

  return { must: mustClauses };
}

// ---------------------------------------------------------------------------
// Query expansion — synonym/expansion map for common engineering terms (Q4-A)
// ---------------------------------------------------------------------------

/**
 * Bidirectional synonym groups for engineering terms.
 * Each group is an array of related terms. When any term from a group appears
 * in the query, the other terms are added as expansion candidates.
 */
export const SYNONYM_GROUPS: string[][] = [
  ['auth', 'authentication', 'authorization', 'login', 'jwt', 'oauth', 'sso'],
  ['db', 'database', 'postgres', 'mysql', 'sqlite', 'sql'],
  ['api', 'rest', 'endpoint', 'route', 'graphql'],
  ['ci', 'cd', 'pipeline', 'deployment', 'deploy'],
  ['test', 'testing', 'unit test', 'integration test', 'e2e'],
  ['cache', 'caching', 'redis', 'memcached'],
  ['queue', 'message queue', 'rabbitmq', 'kafka', 'pubsub'],
  ['container', 'docker', 'kubernetes', 'k8s'],
  ['log', 'logging', 'observability', 'monitoring'],
  ['error', 'exception', 'error handling', 'retry'],
  ['config', 'configuration', 'env', 'environment variable'],
  ['security', 'encryption', 'tls', 'ssl', 'https'],
  ['migration', 'schema migration', 'database migration'],
  ['type', 'typescript', 'typing', 'type safety'],
  ['perf', 'performance', 'optimization', 'latency'],
  ['infra', 'infrastructure', 'cloud', 'aws', 'gcp', 'azure'],
];

/** Pre-built lookup: lowercase term -> set of expansion terms. */
const _expansionIndex = new Map<string, Set<string>>();

function _buildExpansionIndex(): void {
  if (_expansionIndex.size > 0) return;
  for (const group of SYNONYM_GROUPS) {
    for (const term of group) {
      const lower = term.toLowerCase();
      const expansions = new Set<string>();
      for (const other of group) {
        if (other.toLowerCase() !== lower) {
          expansions.add(other.toLowerCase());
        }
      }
      // Merge with existing expansions (a term might appear in multiple groups)
      const existing = _expansionIndex.get(lower);
      if (existing) {
        for (const e of expansions) existing.add(e);
      } else {
        _expansionIndex.set(lower, expansions);
      }
    }
  }
}

/**
 * Expand a search query with synonyms from the engineering term map (Q4-A).
 *
 * Returns the original query plus any expanded terms found. Expanded terms
 * are appended to help BM25/sparse matching without changing the primary
 * dense vector search (which uses only the original query).
 *
 * @param query  The original search query.
 * @returns Object with `original` query and `expanded` query (with synonyms appended).
 */
export function expandQuery(query: string): { original: string; expanded: string; expansions: string[] } {
  _buildExpansionIndex();

  const lowerQuery = query.toLowerCase();
  const words = lowerQuery.split(/\s+/).filter(Boolean);
  const expansions = new Set<string>();

  for (const word of words) {
    const synonyms = _expansionIndex.get(word);
    if (synonyms) {
      for (const syn of synonyms) {
        // Don't add if the synonym is already in the query
        if (!lowerQuery.includes(syn)) {
          expansions.add(syn);
        }
      }
    }
  }

  const expansionList = [...expansions];
  const expanded = expansionList.length > 0
    ? `${query} ${expansionList.join(' ')}`
    : query;

  return { original: query, expanded, expansions: expansionList };
}

// ---------------------------------------------------------------------------
// US5 (013-semantic-embeddings) — Score logging diagnostics
// ---------------------------------------------------------------------------

/**
 * Log the score distribution of a search result set when `VALIS_DEBUG` is set.
 *
 * Output format (one line, stderr via console.warn):
 *   `[qdrant] search mode=hybrid-rrf count=N avg=X.XXX min=X.XXX max=X.XXX`
 *
 * A distribution clustered around 0 indicates the embedding pipeline is
 * misconfigured (probably scroll-fallback). A distribution centered around
 * 0.3–0.7 indicates working embeddings. Operators use this to verify the
 * pipeline end-to-end without writing diagnostic code (FR-021).
 */
function logSearchScores(
  mode: string,
  points: { score?: number }[],
  errorMsg?: string,
): void {
  if (!process.env.VALIS_DEBUG) return;
  if (errorMsg) {
    console.warn(`[qdrant] search mode=${mode} error=${errorMsg}`);
    return;
  }
  if (points.length === 0) {
    console.warn(`[qdrant] search mode=${mode} count=0`);
    return;
  }
  const scores = points.map((p) => p.score ?? 0);
  const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
  const min = Math.min(...scores);
  const max = Math.max(...scores);
  console.warn(
    `[qdrant] search mode=${mode} count=${scores.length} avg=${avg.toFixed(3)} min=${min.toFixed(3)} max=${max.toFixed(3)}`,
  );
}

export async function hybridSearch(
  qdrant: QdrantClient,
  orgId: string,
  query: string,
  options: {
    type?: string;
    limit?: number;
    projectId?: string;
    legacyFallback?: boolean;
    /** BUG #161: 'siblings' (default) returns matched chunk + ±1 context;
     * 'chunk' returns matched chunk only; 'full' returns whole decision body. */
    expand?: SearchExpand;
    /**
     * 032/Track 6: structured filter from `SearchFilterBuilder`. AND-merged
     * with the existing project-scope predicate. Type loose since Qdrant
     * accepts a wider shape than our closed-world builder.
     */
    payload_filter?: { must: unknown[] };
  } = {},
): Promise<SearchResult[]> {
  const { type, limit = 10, projectId, legacyFallback, expand = 'siblings', payload_filter } = options;

  // FR-013a: short-circuit empty queries before any inference call to avoid
  // wasting embedding tokens on no-op requests.
  if (query.trim().length === 0) {
    return [];
  }

  const baseFilter = buildProjectFilter(orgId, projectId, { type, legacyFallback });
  // 032/Track 6: compose project-scope predicate with caller's structured
  // filter. Both have `must[]` shape, so a simple concat is correct.
  const filter =
    payload_filter && Array.isArray(payload_filter.must) && payload_filter.must.length > 0
      ? {
          ...baseFilter,
          must: [
            ...(Array.isArray((baseFilter as { must?: unknown[] }).must)
              ? ((baseFilter as { must: unknown[] }).must as unknown[])
              : []),
            ...payload_filter.must,
          ],
        }
      : baseFilter;

  // Expand query with synonyms for better recall (Q4-A) and truncate to the
  // embedding model's safe input ceiling (FR-013b).
  const { expanded } = expandQuery(query);
  const truncated = truncateForEmbedding(expanded);

  const strategy = await detectEmbeddingStrategy(qdrant, COLLECTION_NAME);

  // 019/US4: pull more candidates than `limit` so chunk-dedup still has
  // enough distinct decisions to fill the requested slot count.
  const fetchLimit = limit * 4;

  try {
    let results;
    let mode: string;
    if (strategy.mode === 'server' && strategy.supportsHybrid) {
      // US3: hybrid prefetch + RRF fusion. Server-side runs both dense and
      // BM25 sub-queries in parallel and fuses with reciprocal rank fusion,
      // combining semantic recall with exact-term precision (FR-008).
      mode = 'hybrid-rrf';
      results = await qdrant.query(COLLECTION_NAME, {
        prefetch: [
          {
            query: strategy.queryForDense(truncated) as never,
            using: DENSE_VECTOR_NAME,
            limit: fetchLimit * 2,
            filter,
          },
          {
            query: strategy.queryForSparse(truncated) as never,
            using: BM25_VECTOR_NAME,
            limit: fetchLimit * 2,
            filter,
          },
        ],
        query: { fusion: 'rrf' } as never,
        filter,
        limit: fetchLimit,
        with_payload: true,
      });
    } else {
      // Client mode (or non-hybrid server): dense-only search.
      mode = 'dense-only';
      const denseQuery: unknown = await (strategy as ClientEmbeddingStrategy).queryForDenseAsync(truncated);
      results = await qdrant.query(COLLECTION_NAME, {
        query: denseQuery as never,
        using: DENSE_VECTOR_NAME,
        filter,
        limit: fetchLimit,
        with_payload: true,
      });
    }

    logSearchScores(mode, results.points);
    const mapped = results.points.map((point) => mapPointToSearchResult(point, point.score || 0));
    return dedupByDecisionId(mapped, limit);
  } catch (err) {
    // Quota errors propagate as structured EmbeddingQuotaError so the caller
    // can render them. Other errors fall through to scroll fallback (FR-010).
    const quota = parseQuotaError(err, strategy.mode);
    if (quota) throw quota;

    logSearchScores('scroll-fallback', [], (err as Error).message);
    const results = await qdrant.scroll(COLLECTION_NAME, {
      filter,
      limit: fetchLimit,
      with_payload: true,
    });

    const mapped = results.points.map((point) => mapPointToSearchResult(point, 0));
    const dedup = dedupByDecisionId(mapped, limit);
    return await applyExpand(qdrant, dedup, expand);
  }
}

/**
 * Map a Qdrant point (from query or scroll) to a SearchResult.
 * Extracts all payload fields including Phase 3 reranker inputs
 * (confidence, pinned, depends_on).
 */
function mapPointToSearchResult(
  point: { id: string | number; payload?: Record<string, unknown> | null | undefined; score?: number },
  score: number,
): SearchResult {
  const payload = (point.payload ?? {}) as Record<string, unknown>;
  // Parent decision id falls back to the point id for legacy single-point
  // (pre-019/US4) records that don't carry a chunk payload.
  const parentId = (payload.decision_id as string) ?? (point.id as string);
  // 0.1.7-dev / BUG #161: chunk_text is the matched window; payload.detail
  // is the full decision body (duplicated across chunks today, separate
  // cleanup tracked). Default detail to chunk_text — full body is opt-in.
  const fullDetail = (payload.detail as string) ?? '';
  const chunkText = (payload.chunk_text as string) ?? fullDetail;
  return {
    id: parentId,
    score,
    type: payload.type as DecisionType,
    summary: (payload.summary as string) || null,
    detail: chunkText,
    author: payload.author as string,
    affects: (payload.affects as string[]) || [],
    created_at: payload.created_at as string,
    // 036 (#90): post-fix points always carry their real status; this
    // `|| 'active'` fallback now only covers legacy pre-036 Qdrant points.
    status: (payload.status as DecisionStatus) || 'active',
    replaced_by: (payload.replaces as string) || null,
    confidence: (payload.confidence as number) ?? null,
    pinned: (payload.pinned as boolean) ?? false,
    depends_on: (payload.depends_on as string[]) ?? [],
    // 028-phase13/Track 5a — outcome from payload; defaults to 'unknown' so
    // rows written before the migration ship are still safely scored.
    outcome:
      (payload.outcome as 'success' | 'failed' | 'partial' | 'unknown') ??
      'unknown',
    // T019: Include project_id and project_name for cross-project result labeling
    project_id: (payload.project_id as string) ?? undefined,
    project_name: (payload.project_name as string) ?? undefined,
    // 0.1.3: surface origin so UI can show "imported via valis index" badge,
    // and so search filters can target organically-captured vs bulk-seeded.
    source: (payload.source as DecisionSource) ?? undefined,
    // 0.1.7-dev / BUG #161: chunk metadata so the search-side enricher can
    // fetch siblings (or the agent can re-query for full=true).
    chunk_index: (payload.chunk_index as number) ?? 0,
    total_chunks: (payload.total_chunks as number) ?? 1,
    detail_scope: 'chunk',
  };
}

/**
 * Deduplicate chunked search results to one entry per parent decision.
 *
 * Per Q3 of speckit.clarify Session 2026-05-03 — "max score per
 * decision_id". Multiple chunks of the same long decision can each match
 * a query; we surface the strongest hit and drop the rest. Ranks the
 * remaining results by descending score and trims to `limit`.
 */
function dedupByDecisionId(
  results: SearchResult[],
  limit: number,
): SearchResult[] {
  const best = new Map<string, SearchResult>();
  for (const r of results) {
    const existing = best.get(r.id);
    if (!existing || r.score > existing.score) {
      best.set(r.id, r);
    }
  }
  return Array.from(best.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/**
 * 0.1.7-dev / BUG #161: enrich dedup'd results with sibling chunks so the
 * agent gets ±1-chunk context around the matched window. Single Qdrant
 * scroll round-trip per call (regardless of result count).
 *
 * - For each result with chunk_index > 0, the prior chunk gets prepended.
 * - For each result with chunk_index < total-1, the next chunk gets appended.
 * - Joined with the original chunk_text using a clear separator so the agent
 *   can detect chunk boundaries if it cares (e.g. for citation precision).
 *
 * Stale or missing siblings (e.g. parent decision was edited mid-search)
 * degrade gracefully — we just skip the missing slot and return what we
 * have. detail_scope is updated to 'siblings' to signal the result shape.
 */
async function enrichWithSiblings(
  qdrant: QdrantClient,
  results: SearchResult[],
): Promise<SearchResult[]> {
  if (results.length === 0) return results;

  // Build a single filter that matches any (decision_id, chunk_index) pair
  // we need. `should: [must:[A,B], must:[C,D]...]` is OR-of-ANDs.
  type Need = { decisionId: string; chunkIndex: number };
  const needs: Need[] = [];
  for (const r of results) {
    const ci = r.chunk_index ?? 0;
    const total = r.total_chunks ?? 1;
    if (total <= 1) continue; // no siblings exist
    if (ci > 0) needs.push({ decisionId: r.id, chunkIndex: ci - 1 });
    if (ci < total - 1) needs.push({ decisionId: r.id, chunkIndex: ci + 1 });
  }
  if (needs.length === 0) {
    return results.map((r) => ({ ...r, detail_scope: 'siblings' as const }));
  }

  let scrollResult;
  try {
    scrollResult = await qdrant.scroll(COLLECTION_NAME, {
      filter: {
        should: needs.map((n) => ({
          must: [
            { key: 'decision_id', match: { value: n.decisionId } },
            { key: 'chunk_index', match: { value: n.chunkIndex } },
          ],
        })),
      },
      limit: needs.length,
      with_payload: true,
    });
  } catch {
    // Sibling fetch is best-effort — on Qdrant error fall back to chunk-only.
    return results.map((r) => ({ ...r, detail_scope: 'chunk' as const }));
  }

  // Index siblings by (decision_id, chunk_index) for O(1) lookup.
  const siblings = new Map<string, string>();
  for (const point of scrollResult.points) {
    const payload = (point.payload ?? {}) as Record<string, unknown>;
    const did = payload.decision_id as string | undefined;
    const ci = payload.chunk_index as number | undefined;
    const text = payload.chunk_text as string | undefined;
    if (did && typeof ci === 'number' && text) {
      siblings.set(`${did}:${ci}`, text);
    }
  }

  return results.map((r) => {
    const ci = r.chunk_index ?? 0;
    const total = r.total_chunks ?? 1;
    if (total <= 1) {
      return { ...r, detail_scope: 'siblings' as const };
    }
    const prev = ci > 0 ? siblings.get(`${r.id}:${ci - 1}`) : undefined;
    const next = ci < total - 1 ? siblings.get(`${r.id}:${ci + 1}`) : undefined;
    const stitched = [prev, r.detail, next].filter(Boolean).join('\n\n…\n\n');
    return { ...r, detail: stitched, detail_scope: 'siblings' as const };
  });
}

/**
 * Replace each result's `detail` (currently chunk_text) with the parent
 * decision's full body fetched once per unique decision_id from chunk 0
 * payload. Used when the caller asked `expand: 'full'`.
 */
async function enrichWithFullDetail(
  qdrant: QdrantClient,
  results: SearchResult[],
): Promise<SearchResult[]> {
  if (results.length === 0) return results;

  const decisionIds = Array.from(new Set(results.map((r) => r.id)));

  let scrollResult;
  try {
    scrollResult = await qdrant.scroll(COLLECTION_NAME, {
      filter: {
        should: decisionIds.map((id) => ({
          must: [
            { key: 'decision_id', match: { value: id } },
            { key: 'chunk_index', match: { value: 0 } },
          ],
        })),
      },
      limit: decisionIds.length,
      with_payload: true,
    });
  } catch {
    return results.map((r) => ({ ...r, detail_scope: 'chunk' as const }));
  }

  const fullByDecision = new Map<string, string>();
  for (const point of scrollResult.points) {
    const payload = (point.payload ?? {}) as Record<string, unknown>;
    const did = payload.decision_id as string | undefined;
    const detail = payload.detail as string | undefined;
    if (did && detail) fullByDecision.set(did, detail);
  }

  return results.map((r) => {
    const full = fullByDecision.get(r.id);
    return full
      ? { ...r, detail: full, detail_scope: 'full' as const }
      : { ...r, detail_scope: 'chunk' as const };
  });
}

/**
 * Apply the requested return granularity per BUG #161.
 * Default ('siblings') gives the matched chunk plus ±1 context — best balance
 * of token economy vs context completeness for typical agent queries.
 */
async function applyExpand(
  qdrant: QdrantClient,
  results: SearchResult[],
  expand: SearchExpand,
): Promise<SearchResult[]> {
  if (expand === 'chunk') return results; // already chunk_text
  if (expand === 'full') return enrichWithFullDetail(qdrant, results);
  return enrichWithSiblings(qdrant, results);
}

/**
 * T019: Cross-project search across multiple accessible projects.
 *
 * Used by --all-projects mode. Accepts an array of project IDs the
 * member has access to and uses `buildAllProjectsFilter` to match any.
 */
export async function hybridSearchAllProjects(
  qdrant: QdrantClient,
  orgId: string,
  query: string,
  projectIds: string[],
  options: {
    type?: string;
    limit?: number;
    /** BUG #161: see hybridSearch.expand. */
    expand?: SearchExpand;
  } = {},
): Promise<SearchResult[]> {
  const { type, limit = 10, expand = 'siblings' } = options;

  // FR-013a: short-circuit empty queries before any inference call.
  if (query.trim().length === 0) {
    return [];
  }

  const filter = buildAllProjectsFilter(orgId, projectIds, { type });

  // Expand query with synonyms (FR-013) and truncate to the embedding
  // model's safe input ceiling (FR-013b).
  const { expanded } = expandQuery(query);
  const truncated = truncateForEmbedding(expanded);

  const strategy = await detectEmbeddingStrategy(qdrant, COLLECTION_NAME);

  // 019/US4: over-fetch so chunk-dedup still surfaces `limit` distinct decisions.
  const fetchLimit = limit * 4;

  try {
    let results;
    let mode: string;
    if (strategy.mode === 'server' && strategy.supportsHybrid) {
      // US3: hybrid prefetch + RRF fusion (cross-project variant).
      mode = 'hybrid-rrf-cross';
      results = await qdrant.query(COLLECTION_NAME, {
        prefetch: [
          {
            query: strategy.queryForDense(truncated) as never,
            using: DENSE_VECTOR_NAME,
            limit: fetchLimit * 2,
            filter,
          },
          {
            query: strategy.queryForSparse(truncated) as never,
            using: BM25_VECTOR_NAME,
            limit: fetchLimit * 2,
            filter,
          },
        ],
        query: { fusion: 'rrf' } as never,
        filter,
        limit: fetchLimit,
        with_payload: true,
      });
    } else {
      mode = 'dense-only-cross';
      const denseQuery: unknown = await (strategy as ClientEmbeddingStrategy).queryForDenseAsync(truncated);
      results = await qdrant.query(COLLECTION_NAME, {
        query: denseQuery as never,
        using: DENSE_VECTOR_NAME,
        filter,
        limit: fetchLimit,
        with_payload: true,
      });
    }

    logSearchScores(mode, results.points);
    const mapped = results.points.map((point) => mapPointToSearchResult(point, point.score || 0));
    const dedup = dedupByDecisionId(mapped, limit);
    return await applyExpand(qdrant, dedup, expand);
  } catch (err) {
    const quota = parseQuotaError(err, strategy.mode);
    if (quota) throw quota;

    logSearchScores('scroll-fallback-cross', [], (err as Error).message);
    const results = await qdrant.scroll(COLLECTION_NAME, {
      filter,
      limit: fetchLimit,
      with_payload: true,
    });

    const mapped = results.points.map((point) => mapPointToSearchResult(point, 0));
    const dedup = dedupByDecisionId(mapped, limit);
    return await applyExpand(qdrant, dedup, expand);
  }
}
