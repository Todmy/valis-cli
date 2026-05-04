import { QdrantClient } from '@qdrant/js-client-rest';
import type { RawDecision, SearchResult, DecisionType } from '../types.js';
import {
  detectEmbeddingStrategy,
  truncateForEmbedding,
  parseQuotaError,
  ClientEmbeddingStrategy,
  EmbeddingQuotaError,
  DENSE_VECTOR_NAME,
  BM25_VECTOR_NAME,
  VECTOR_SIZE,
  REINDEX_BATCH_SIZE,
  REINDEX_ABORT_THRESHOLD,
  getActiveCollectionName,
  getDualWriteCollection,
  vectorForUpsertAtVersion,
} from './embedding.js';
import { chunkText, type Chunk } from './chunking.js';
import { createHash } from 'node:crypto';

/**
 * Build a deterministic UUIDv5-shaped point ID for a chunk N>0 of a parent
 * decision. Chunk 0 always reuses the parent decision UUID so existing
 * Postgres FK references and external links keep resolving.
 *
 * The shape (8-4-4-4-12 hex) is what Qdrant accepts as a UUID-format point ID.
 * We derive it from sha256(parentId + ':' + index) and format the first 32
 * hex chars with the UUIDv5 layout (variant bits set so it's a valid UUID).
 */
function chunkPointId(parentDecisionId: string, chunkIndex: number): string {
  if (chunkIndex === 0) return parentDecisionId;
  const h = createHash('sha256')
    .update(`${parentDecisionId}:chunk:${chunkIndex}`)
    .digest('hex');
  // RFC 4122 v5-shaped: set version=5 in high nibble of byte 6, variant=10
  // in high bits of byte 8.
  const b6 = ((parseInt(h.slice(12, 14), 16) & 0x0f) | 0x50)
    .toString(16)
    .padStart(2, '0');
  const b8 = ((parseInt(h.slice(16, 18), 16) & 0x3f) | 0x80)
    .toString(16)
    .padStart(2, '0');
  return [
    h.slice(0, 8),
    h.slice(8, 12),
    `${b6}${h.slice(14, 16)}`,
    `${b8}${h.slice(18, 20)}`,
    h.slice(20, 32),
  ].join('-');
}

/**
 * Active Qdrant collection. Resolved at module load against
 * `EMBEDDING_ACTIVE_VERSION` so the alias-swap is a single env-var flip
 * + redeploy. See `embedding.ts` `getActiveCollectionName`.
 */
export const COLLECTION_NAME: string = getActiveCollectionName();

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
  /**
   * Origin of this decision (mcp_store, seed, file_watcher, ...).
   * Surfaced in search results so the UI can distinguish bulk-imported
   * (`seed`) decisions from organically-captured ones.
   */
  source?: string;
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
    source: extras?.source ?? null,
    created_at: new Date().toISOString(),
  };

  // Include project_id when available (omitted for legacy compat)
  if (projectId) {
    payload.project_id = projectId;
  }

  // 019/US4 — chunk long decisions for the e5-large 514-token window.
  // Each chunk becomes a separate Qdrant point sharing the same parent
  // payload + carrying chunk-specific metadata (decision_id, chunk_index,
  // total_chunks, chunk_text). Search-side dedup groups by decision_id and
  // keeps the max score per parent decision.
  const strategy = await detectEmbeddingStrategy(qdrant, COLLECTION_NAME);
  const chunks: Chunk[] = chunkText(contextualText);

  // Dual-write window (US4): when `EMBEDDING_DUAL_WRITE=1`, we also write the
  // same decision to the inactive-version collection so it stays warm during
  // the migration / 7-day retention. Inactive-version writes use the same
  // strategy class but a different model + char ceiling (`v1` vs `v2`).
  const dualTarget = strategy.mode === 'server' ? getDualWriteCollection() : null;

  const buildPointForChunk = async (chunk: Chunk) => {
    const chunkPayload: Record<string, unknown> = {
      ...payload,
      decision_id: decisionId,
      chunk_index: chunk.index,
      total_chunks: chunk.total,
      chunk_text: chunk.text,
    };
    const embedInput = truncateForEmbedding(chunk.text);
    const vector =
      strategy.mode === 'server'
        ? strategy.vectorForUpsert(embedInput)
        : await (strategy as ClientEmbeddingStrategy).vectorForUpsertAsync(embedInput);
    return {
      id: chunkPointId(decisionId, chunk.index),
      payload: chunkPayload,
      vector: vector as never,
    };
  };

  try {
    const points = await Promise.all(chunks.map(buildPointForChunk));

    if (dualTarget) {
      // Dual-write — both upserts MUST succeed; if either fails, the function
      // throws and the caller's outer handling decides retry / offline-queue.
      const dualPoints = chunks.map((chunk) => ({
        id: chunkPointId(decisionId, chunk.index),
        payload: {
          ...payload,
          decision_id: decisionId,
          chunk_index: chunk.index,
          total_chunks: chunk.total,
          chunk_text: chunk.text,
        },
        vector: vectorForUpsertAtVersion(chunk.text, dualTarget.version) as never,
      }));
      await Promise.all([
        qdrant.upsert(COLLECTION_NAME, { points }),
        qdrant.upsert(dualTarget.collection, { points: dualPoints }),
      ]);
    } else {
      await qdrant.upsert(COLLECTION_NAME, { points });
    }
  } catch (err) {
    const quota = parseQuotaError(err, strategy.mode);
    if (quota) {
      // Re-throw as a structured error. The capture / store flow catches this
      // and routes the decision into the offline queue (~/.valis/pending.jsonl)
      // per FR-023a / Constitution III (Non-Blocking).
      throw quota;
    }
    throw err;
  }
}

/**
 * Update the `pinned` payload field on an existing Qdrant point.
 *
 * Used by the pin/unpin lifecycle actions to keep Qdrant in sync with
 * Postgres so that the recencyDecay signal can read `pinned` at search time.
 */
/**
 * 019/US4 helper: apply a payload patch to all chunks of a decision (or
 * the legacy single point if the record predates chunking). Keeps multi-chunk
 * payload coherent for downstream readers.
 */
export async function setDecisionPayload(
  qdrant: QdrantClient,
  decisionId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await qdrant.setPayload(COLLECTION_NAME, {
    payload,
    filter: {
      should: [
        { must: [{ key: 'decision_id', match: { value: decisionId } }] },
        { has_id: [decisionId] },
      ],
    },
  } as never);
}

export async function updatePinnedPayload(
  qdrant: QdrantClient,
  decisionId: string,
  pinned: boolean,
): Promise<void> {
  // 019/US4: a decision may live as N chunk points sharing decision_id.
  // Update by filter so all chunks stay in sync. Filter also matches the
  // legacy single-point case where the point id == decision id (no
  // decision_id payload field) — should clause covers both shapes.
  await qdrant.setPayload(COLLECTION_NAME, {
    payload: { pinned },
    filter: {
      should: [
        { must: [{ key: 'decision_id', match: { value: decisionId } }] },
        { has_id: [decisionId] },
      ],
    },
  } as never);
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
    expand?: import('../types.js').SearchExpand;
  } = {},
): Promise<SearchResult[]> {
  const { type, limit = 10, projectId, legacyFallback, expand = 'siblings' } = options;

  // FR-013a: short-circuit empty queries before any inference call to avoid
  // wasting embedding tokens on no-op requests.
  if (query.trim().length === 0) {
    return [];
  }

  const filter = buildProjectFilter(orgId, projectId, { type, legacyFallback });

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
    status: (payload.status as import('../types.js').DecisionStatus) || 'active',
    replaced_by: (payload.replaces as string) || null,
    confidence: (payload.confidence as number) ?? null,
    pinned: (payload.pinned as boolean) ?? false,
    depends_on: (payload.depends_on as string[]) ?? [],
    // T019: Include project_id and project_name for cross-project result labeling
    project_id: (payload.project_id as string) ?? undefined,
    project_name: (payload.project_name as string) ?? undefined,
    // 0.1.3: surface origin so UI can show "imported via valis index" badge,
    // and so search filters can target organically-captured vs bulk-seeded.
    source: (payload.source as import('../types.js').DecisionSource) ?? undefined,
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
  expand: import('../types.js').SearchExpand,
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
    expand?: import('../types.js').SearchExpand;
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
