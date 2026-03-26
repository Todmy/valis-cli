import { QdrantClient } from '@qdrant/js-client-rest';
import type { RawDecision, SearchResult, DecisionType } from '../types.js';

export const COLLECTION_NAME = 'decisions';
const VECTOR_SIZE = 384;

/** Batch size for the Qdrant project_id backfill migration. */
const MIGRATION_BATCH_SIZE = 100;

let client: QdrantClient | null = null;

export function getQdrantClient(url: string, apiKey: string): QdrantClient {
  if (!client) {
    client = new QdrantClient({ url, apiKey });
  }
  return client;
}

export function resetClient(): void {
  client = null;
}

export async function ensureCollection(qdrant: QdrantClient): Promise<void> {
  try {
    await qdrant.getCollection(COLLECTION_NAME);
  } catch {
    await qdrant.createCollection(COLLECTION_NAME, {
      vectors: {
        size: VECTOR_SIZE,
        distance: 'Cosine',
        on_disk: true,
      },
      sparse_vectors: {
        bm25: {
          modifier: 'idf' as never,
        },
      },
    });

    // Create payload indexes
    await qdrant.createPayloadIndex(COLLECTION_NAME, {
      field_name: 'org_id',
      field_schema: 'keyword',
    });

    await qdrant.createPayloadIndex(COLLECTION_NAME, {
      field_name: 'type',
      field_schema: 'keyword',
    });

    await qdrant.createPayloadIndex(COLLECTION_NAME, {
      field_name: 'project_id',
      field_schema: 'keyword',
    });
  }
}

/**
 * Ensure the `project_id` keyword payload index exists on an existing collection.
 *
 * Idempotent — Qdrant silently ignores duplicate index creation requests.
 * Called during migration or on first startup after upgrade to guarantee the
 * index is present regardless of whether ensureCollection created it.
 */
export async function ensureProjectIdIndex(qdrant: QdrantClient): Promise<void> {
  try {
    await qdrant.createPayloadIndex(COLLECTION_NAME, {
      field_name: 'project_id',
      field_schema: 'keyword',
    });
  } catch {
    // Index already exists or collection doesn't exist yet — both are fine.
  }
}

/** Optional extended fields for decision upsert (Phase 3 — search growth). */
export interface UpsertExtras {
  pinned?: boolean;
  status?: string;
  depends_on?: string[];
  replaces?: string | null;
  /** Project UUID. Included in payload for project-scoped filtering. */
  project_id?: string;
}

/**
 * Build a contextual text string that prepends type and affects metadata
 * to the raw decision text (Q4-C). This gives the embedding model richer
 * context about the decision's domain, improving vector search recall.
 *
 * Format: `[{type}] [{affects joined}] {text}`
 * Example: `[decision] [authentication, security] Use JWT with RS256 for API auth`
 */
export function buildContextualText(
  text: string,
  type: string | undefined,
  affects: string[] | undefined,
): string {
  const typePart = `[${type || 'pending'}]`;
  const affectsPart = affects && affects.length > 0 ? ` [${affects.join(', ')}]` : '';
  return `${typePart}${affectsPart} ${text}`;
}

/**
 * Generate a hypothetical question that a decision answers (HyPE — Hypothetical
 * Passage Embedding, from Q4-A). Stored in payload for better retrieval at
 * search time.
 *
 * Uses template-based generation (no LLM required):
 * - If `affects` areas exist: "What is the team's decision about {affects}?"
 * - If summary exists: "What did the team decide regarding {summary}?"
 * - Fallback: uses the first 80 chars of the decision text.
 */
export function generateHypotheticalQuery(raw: RawDecision): string {
  const affects = raw.affects ?? [];

  if (affects.length > 0) {
    return `What is the team's decision about ${affects.join(', ')}?`;
  }

  if (raw.summary) {
    return `What did the team decide regarding ${raw.summary}?`;
  }

  // Fallback: use truncated text
  const truncated = raw.text.slice(0, 80).replace(/\s+/g, ' ').trim();
  return `What did the team decide regarding ${truncated}?`;
}

export async function upsertDecision(
  qdrant: QdrantClient,
  orgId: string,
  decisionId: string,
  raw: RawDecision,
  author: string,
  extras?: UpsertExtras,
): Promise<void> {
  // Resolve project_id from extras or raw decision
  const projectId = extras?.project_id ?? raw.project_id ?? undefined;

  // Build contextual text for richer embeddings (Q4-C)
  const contextualText = buildContextualText(raw.text, raw.type, raw.affects);

  // Generate HyPE hypothetical query for better retrieval (Q4-A)
  const hypotheticalQuery = generateHypotheticalQuery(raw);

  // Use Qdrant's server-side embedding by sending the text as document
  // Qdrant Cloud with FastEmbed generates embeddings server-side
  const payload: Record<string, unknown> = {
    org_id: orgId,
    type: raw.type || 'pending',
    summary: raw.summary || null,
    detail: raw.text,
    contextual_text: contextualText,
    hypothetical_query: hypotheticalQuery,
    author,
    affects: raw.affects || [],
    confidence: raw.confidence || null,
    pinned: extras?.pinned ?? false,
    replaces: extras?.replaces ?? null as string | null,
    depends_on: extras?.depends_on ?? [] as string[],
    status: extras?.status ?? 'active',
    created_at: new Date().toISOString(),
  };

  // Include project_id when available (omitted for legacy compat)
  if (projectId) {
    payload.project_id = projectId;
  }

  await qdrant.upsert(COLLECTION_NAME, {
    points: [
      {
        id: decisionId,
        payload,
        // Placeholder zero vector — Qdrant Cloud with server-side embedding
        // will generate the actual vector from the document field.
        // If server-side embeddings aren't configured, search falls back to
        // payload filtering only.
        vector: new Array(VECTOR_SIZE).fill(0),
      },
    ],
  });
}

/**
 * Update the `pinned` payload field on an existing Qdrant point.
 *
 * Used by the pin/unpin lifecycle actions to keep Qdrant in sync with
 * Postgres so that the recencyDecay signal can read `pinned` at search time.
 */
export async function updatePinnedPayload(
  qdrant: QdrantClient,
  decisionId: string,
  pinned: boolean,
): Promise<void> {
  await qdrant.setPayload(COLLECTION_NAME, {
    payload: { pinned },
    points: [decisionId],
  });
}

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
    const shouldClauses: Record<string, unknown>[] = projectIds.map((id) => ({
      key: 'project_id',
      match: { value: id },
    }));
    // Include legacy points
    shouldClauses.push({ is_null: { key: 'project_id' } });
    mustClauses.push({ should: shouldClauses });
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

export async function hybridSearch(
  qdrant: QdrantClient,
  orgId: string,
  query: string,
  options: { type?: string; limit?: number; projectId?: string; legacyFallback?: boolean } = {},
): Promise<SearchResult[]> {
  const { type, limit = 10, projectId, legacyFallback } = options;

  const filter = buildProjectFilter(orgId, projectId, { type, legacyFallback });

  // Expand query with synonyms for better recall (Q4-A)
  const { expanded } = expandQuery(query);

  try {
    // Try query-based search (requires server-side embeddings)
    // Use expanded query for broader matching
    const results = await qdrant.query(COLLECTION_NAME, {
      query: expanded,
      filter,
      limit,
      with_payload: true,
    });

    return results.points.map((point) => mapPointToSearchResult(point, point.score || 0));
  } catch {
    // Fallback: scroll with filter only (no vector search)
    const results = await qdrant.scroll(COLLECTION_NAME, {
      filter,
      limit,
      with_payload: true,
    });

    return results.points.map((point) => mapPointToSearchResult(point, 0));
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
  return {
    id: point.id as string,
    score,
    type: payload.type as DecisionType,
    summary: (payload.summary as string) || null,
    detail: payload.detail as string,
    author: payload.author as string,
    affects: (payload.affects as string[]) || [],
    created_at: payload.created_at as string,
    status: (payload.status as import('../types.js').DecisionStatus) || 'active',
    replaced_by: (payload.replaces as string) || null,
    confidence: (payload.confidence as number) ?? null,
    pinned: (payload.pinned as boolean) ?? false,
    depends_on: (payload.depends_on as string[]) ?? [],
    // T019: Include project_id and project_name for cross-project result labeling
    project_id: (payload.project_id as string) ?? undefined,
    project_name: (payload.project_name as string) ?? undefined,
  };
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
  options: { type?: string; limit?: number } = {},
): Promise<SearchResult[]> {
  const { type, limit = 10 } = options;

  const filter = buildAllProjectsFilter(orgId, projectIds, { type });

  try {
    const results = await qdrant.query(COLLECTION_NAME, {
      query,
      filter,
      limit,
      with_payload: true,
    });

    return results.points.map((point) => mapPointToSearchResult(point, point.score || 0));
  } catch {
    const results = await qdrant.scroll(COLLECTION_NAME, {
      filter,
      limit,
      with_payload: true,
    });

    return results.points.map((point) => mapPointToSearchResult(point, 0));
  }
}

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

export async function healthCheck(qdrant: QdrantClient): Promise<boolean> {
  try {
    await qdrant.getCollections();
    return true;
  } catch {
    return false;
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
