/**
 * gh#329 — read-only search over the reference library (`sources_v1`).
 *
 * The library is a corpus of externally authored engineering standards and
 * handbooks, indexed in its own Qdrant collection. It is deliberately NOT the
 * decision store: no source record takes part in lifecycle, outcomes,
 * contradiction detection, dedup, or synthesis. Physical collection
 * separation — not a payload discriminator — is what guarantees that, because
 * two org-wide consumers (`cleanup/dedup.ts:162`, `synthesis/cluster-registry.ts:292`)
 * take no scope parameter and would otherwise sweep the corpus in. See ADR 0004.
 *
 * The failure contract is the point of this module. An empty result read as
 * "the library holds no evidence" when the library is actually broken is the
 * failure mode the whole feature exists to prevent, so every fault path throws
 * a `LibraryError` with a named code rather than returning `[]`.
 */

import type { ServerConfig } from '../../types.js';
import type { ReadAccess } from '../../lib/project-access.js';
import { getServiceRoleSupabase, resolveReadAccess } from '../../lib/project-access.js';
import { getQdrantClient } from '../../cloud/qdrant/client.js';
import { storeAuditEntry } from '../../cloud/supabase/audit.js';
import { loadConfig } from '../../config/store.js';
import { findProjectConfig } from '../../config/project.js';

export type LibraryErrorCode =
  | 'library_not_configured'
  | 'library_forbidden'
  | 'library_unavailable'
  | 'library_rebuild_required';

/**
 * Failure carrier whose `message` IS the structured payload.
 *
 * Verified against `@modelcontextprotocol/sdk@1.27.1`: the SDK catches any
 * exception a tool handler throws and returns `createToolError(err.message)` —
 * `{content:[{type:'text',text:message}], isError:true}`, a *successful*
 * JSON-RPC result, not a protocol error (`server/mcp.js:100,140-158`). Only
 * `err.message` survives; `code` and any custom property are discarded on the
 * wire. Serialising the payload into the message is what makes the failure
 * legible to the client, and it deliberately carries no `results` key so no
 * consumer can normalise it into an empty result with `results ?? []`.
 *
 * `code` and `missing` are still assigned on the instance because
 * `classifyError` (`analytics.ts:48-58`) reads `err.code` locally, before the
 * SDK ever sees the throw. Declaring them without assigning would emit
 * `error_code: 'Error'` into telemetry.
 */
export class LibraryError extends Error {
  readonly code: LibraryErrorCode;
  readonly missing: string;

  constructor(code: LibraryErrorCode, missing: string, human: string) {
    super(JSON.stringify({ error: { code, missing, message: human } }));
    this.name = 'LibraryError';
    this.code = code;
    this.missing = missing;
  }
}

/**
 * Resolve which project's library to read: the caller's own by default, or the
 * one they explicitly named.
 *
 * A library is an attachment of a project, not a property of the installation
 * (gh#334). The previous shape resolved it from a single `VALIS_LIBRARY_PROJECT_ID`
 * env var, which made one project's corpus visible from every other project on
 * the deployment and gave a second project no way to have a library at all.
 *
 * `target_project_id` is safe as a caller argument for the same reason it is on
 * `valis_search` (feature 033): naming a project is not reading it. Every read
 * passes through `assertLibraryReadable`, which resolves the TARGET project's
 * own access rules — membership, or `visibility = 'public'`. A caller may name
 * any project id and will still only ever read one they are entitled to.
 */
export function resolveLibraryProjectId(
  args?: { target_project_id?: string },
  config?: { project_id?: string | null },
): string | undefined {
  return args?.target_project_id?.trim() || config?.project_id || undefined;
}

/**
 * Credentials the handler cannot proceed without, in report order.
 *
 * `library_project_id` is a resolved value carried on the config object for the
 * length of one call, not a stored setting — `ServerConfig` no longer has such
 * a field, because a deployment does not own a library (gh#334).
 */
type LibraryInput = ServerConfig & { library_project_id?: string };
type LibraryConfig = ServerConfig & { library_project_id: string };

/**
 * Fail before any network call when the tool cannot possibly succeed, naming
 * the field that is absent. An installation with no library is a valid
 * installation — `library_not_configured` is an honest state, not a defect —
 * so this is reported, never repaired.
 *
 * The first entry is reported as `project_id` rather than by its internal key:
 * what the caller is actually missing is an active project (and they supplied
 * no `target_project_id`), not a deployment setting they could go and set.
 */
export function assertLibraryConfigured(
  config: LibraryInput | undefined,
): asserts config is LibraryConfig {
  const missing = ([
    ['project_id', config?.library_project_id],
    ['qdrant_url', config?.qdrant_url],
    ['supabase_url', config?.supabase_url],
    ['supabase_service_role_key', config?.supabase_service_role_key],
    ['member_id', config?.member_id],
  ] as const).find(([, value]) => !value)?.[0];

  if (missing) {
    throw new LibraryError(
      'library_not_configured',
      missing,
      `The reference library is not configured on this server: ${missing} is not set.`,
    );
  }

  // A present-but-malformed URL is a misconfiguration and has to be named
  // here. Left to the client constructors it surfaces as a plain `TypeError`
  // from outside this module's classification, so the caller receives a bare
  // message instead of the `{error:{code,...}}` body — and a proxy that drops
  // `isError` (`proxy.ts:84`) then presents it as success.
  const malformed = ([
    ['qdrant_url', config?.qdrant_url],
    ['supabase_url', config?.supabase_url],
  ] as const).find(([, value]) => !URL.canParse(value as string))?.[0];

  if (malformed) {
    throw new LibraryError(
      'library_not_configured',
      malformed,
      `The reference library is not configured on this server: ${malformed} is not a valid URL.`,
    );
  }
}

/**
 * Gate the read on the library project's own access rules — membership OR
 * `visibility = 'public'` (feature 033), so a cross-org caller can be
 * legitimately authorised.
 *
 * Takes the resolver as a parameter rather than calling it directly so the
 * three outcomes can be asserted without a Supabase double. The distinction
 * that matters: `'deny'` is an authoritative negative, `'unavailable'` means
 * the question was never answered — reporting the second as the first would
 * tell a legitimate reader "you may not" during an outage.
 *
 * On any non-`allow` outcome this throws before a Qdrant client is built, so
 * an unauthorised caller produces no cluster traffic at all.
 */
export async function assertLibraryReadable(
  resolve: () => Promise<ReadAccess>,
  libraryProjectId: string,
): Promise<void> {
  const access = await resolve();
  if (access === 'allow') return;

  if (access === 'unavailable') {
    throw new LibraryError(
      'library_unavailable',
      'authorization',
      'Could not determine access to the reference library; the authorization backend is unavailable.',
    );
  }

  throw new LibraryError(
    'library_forbidden',
    `project:${libraryProjectId}`,
    'You do not have access to the reference library.',
  );
}

/** The collection this tool reads. Never a parameter — see ADR 0004. */
export const SOURCES_COLLECTION = 'sources_v1';

/** Dense vector width of `intfloat/multilingual-e5-small`. */
const DENSE_SIZE = 384;

/**
 * Payload indexes the tool's declared filter surface depends on, with their
 * declared types. Qdrant answers a filter on an unindexed keyword field with
 * HTTP 400 (`Index required but not found for "X"`, verified on the live
 * cluster), so an advertised filter without its index is a promise with no
 * implementation.
 */
export const REQUIRED_INDEXES: ReadonlyArray<{ field: string; dataType: 'keyword' }> = [
  { field: 'project_id', dataType: 'keyword' },
  { field: 'lang', dataType: 'keyword' },
  { field: 'tier', dataType: 'keyword' },
  { field: 'identifier', dataType: 'keyword' },
  { field: 'title', dataType: 'keyword' },
];

interface CollectionInfoLike {
  config?: {
    params?: {
      vectors?: Record<string, { size?: number }> | { size?: number };
      sparse_vectors?: Record<string, unknown>;
    };
  };
  payload_schema?: Record<string, { data_type?: string }>;
}

/**
 * Verify the collection still matches the contract the tool relies on.
 *
 * Deliberately checks the FULL contract on EVERY call, uncached, regardless of
 * which filters the current query uses. Acceptance criterion 4 is written
 * unconditionally, and an unfiltered query submits no `title` filter — so any
 * cache window, or any "check only what this call needs" shortcut, is a window
 * in which a deleted index is invisible and the search proceeds as if healthy.
 * The cost is one control-plane call alongside a query that already runs two
 * server-side embeddings and an RRF fusion.
 *
 * Detection only. Repairing anything here would breach the read-only boundary.
 */
export function assertLibrarySchema(info: CollectionInfoLike | null | undefined): void {
  if (!info) {
    throw new LibraryError(
      'library_unavailable',
      `collection:${SOURCES_COLLECTION}`,
      `The reference library collection "${SOURCES_COLLECTION}" is not present on the cluster.`,
    );
  }

  const params = info.config?.params;
  const vectors = params?.vectors as Record<string, { size?: number }> | undefined;
  const dense = vectors?.[''];
  if (!dense || dense.size !== DENSE_SIZE) {
    throw new LibraryError(
      'library_rebuild_required',
      'vector:dense',
      `The reference library is missing its ${DENSE_SIZE}-dimension dense vector; it needs reindexing.`,
    );
  }

  if (!params?.sparse_vectors || !('bm25' in params.sparse_vectors)) {
    throw new LibraryError(
      'library_rebuild_required',
      'vector:bm25',
      'The reference library is missing its bm25 sparse vector; it needs reindexing.',
    );
  }

  for (const { field, dataType } of REQUIRED_INDEXES) {
    if (info.payload_schema?.[field]?.data_type !== dataType) {
      throw new LibraryError(
        'library_rebuild_required',
        `index:${field}`,
        `The reference library needs a ${dataType} payload index on "${field}".`,
      );
    }
  }
}

const DENSE_MODEL = 'intfloat/multilingual-e5-small';
const BM25_MODEL = 'Qdrant/bm25';
const DEFAULT_K = 5;
const MAX_K = 20;
/** Prefetch depth per branch before fusion — mirrors the decision path. */
const PREFETCH_FACTOR = 8;

export interface LibraryFilters {
  lang?: string;
  tier?: string;
  identifier?: string;
  /** Matches the work's `title` payload key. */
  work?: string;
}

export interface LibrarySearchArgs {
  query: string;
  k?: number;
  filters?: LibraryFilters;
  /** Read another project's library instead of the caller's own (gh#334). */
  target_project_id?: string;
}

/**
 * Scope filter. `project_id` alone, deliberately.
 *
 * Measured on the live cluster 2026-08-13: `project_id` selects 16,344 of
 * 16,344 corpus points with none outside it, so `org_id` would add no
 * restriction — and because a stamped org goes stale the moment the project
 * moves between orgs, adding it would turn an intact corpus into a permanent
 * false denial. Authorisation is a separate question, answered upstream by
 * `assertLibraryReadable`.
 */
export function buildScopeFilter(libraryProjectId: string, filters?: LibraryFilters) {
  const must: Array<{ key: string; match: { value: string } }> = [
    { key: 'project_id', match: { value: libraryProjectId } },
  ];
  const mapped: ReadonlyArray<[keyof LibraryFilters, string]> = [
    ['lang', 'lang'],
    ['tier', 'tier'],
    ['identifier', 'identifier'],
    ['work', 'title'],
  ];
  for (const [arg, key] of mapped) {
    const value = filters?.[arg];
    if (value) must.push({ key, match: { value } });
  }
  return { must };
}

export type QdrantLike = {
  getCollection(name: string): Promise<unknown>;
  query(name: string, body: Record<string, unknown>): Promise<{ points?: unknown[] }>;
  count(name: string, body: Record<string, unknown>): Promise<{ count: number }>;
  facet(
    name: string,
    body: Record<string, unknown>,
  ): Promise<{ hits?: Array<{ value?: unknown; count?: number }> }>;
};

/**
 * Guard, then retrieve. Server-side inference only — there is no local
 * embedding fallback, because `ClientEmbeddingStrategy` uses AllMiniLML6V2
 * (`embedding.ts:283`), a different model from the one this corpus was built
 * with. When server inference is unavailable the right answer is a failure,
 * not a wrong one.
 *
 * No relevance threshold, and no pretence of one: RRF scores are rank-derived,
 * so the top hit is ~1.0 for any query including nonsense. A hit is a candidate
 * passage, not a claim of relevance.
 */
export async function searchLibrary(
  client: QdrantLike,
  libraryProjectId: string,
  args: LibrarySearchArgs,
): Promise<{ points: unknown[]; scopedCount: number | null }> {
  const query = args.query?.trim();
  if (!query) {
    throw new LibraryError(
      'library_unavailable',
      'query_failed',
      'A non-empty query is required.',
    );
  }

  assertLibrarySchema(
    (await client.getCollection(SOURCES_COLLECTION).catch(() => null)) as never,
  );

  const k = Math.min(Math.max(1, args.k ?? DEFAULT_K), MAX_K);
  const filter = buildScopeFilter(libraryProjectId, args.filters);
  const prefetchLimit = k * PREFETCH_FACTOR;

  const result = await client.query(SOURCES_COLLECTION, {
    prefetch: [
      { query: { text: query, model: DENSE_MODEL }, using: '', limit: prefetchLimit },
      { query: { text: query, model: BM25_MODEL }, using: 'bm25', limit: prefetchLimit },
    ],
    query: { fusion: 'rrf' },
    filter,
    limit: k,
    with_payload: true,
  });

  const points = result.points ?? [];
  if (points.length > 0) return { points, scopedCount: null };

  // Zero hits has three causes and conflating them is the failure this tool
  // exists to prevent:
  //   points match the active filter, yet retrieval returned none → broken
  //   nothing matches the filter but the scope is populated       → excluded
  //   nothing matches the scope either                            → absent
  //
  // Counting under the FULL active filter is what separates the first from the
  // rest. Counting under the scope alone answers "is the corpus there", which
  // is the wrong question when the caller sent no filters at all: a dead
  // inference endpoint over a healthy corpus would be reported as
  // `excluded_by_filters` — blaming filters that were never supplied.
  const { count: matching } = await client.count(SOURCES_COLLECTION, {
    filter,
    exact: true,
  });

  if (matching > 0) {
    throw new LibraryError(
      'library_unavailable',
      'retrieval:empty',
      'The reference library holds passages matching this request but returned none; retrieval is not working.',
    );
  }

  // Nothing matches the active filter. With no caller filters that count WAS
  // the scope count, so the corpus is absent and a second call would ask the
  // same question twice.
  const narrowed = filter.must.length > 1;
  const scopedCount = narrowed
    ? (
        await client.count(SOURCES_COLLECTION, {
          filter: buildScopeFilter(libraryProjectId),
          exact: true,
        })
      ).count
    : 0;

  if (scopedCount === 0) {
    throw new LibraryError(
      'library_rebuild_required',
      'corpus:absent',
      'The reference library holds no documents under its configured scope; it needs reingesting.',
    );
  }

  return { points, scopedCount };
}

export interface LibraryHit {
  title: string;
  page: number;
  identifier: string | null;
  lang: string | null;
  year: number | null;
  work_id: string | null;
  chunk_text: string;
  contextual_text: string | null;
  score: number;
}

export interface LibraryResult {
  results: LibraryHit[];
  /** Always present, so a partial drop is visible rather than silent. */
  dropped_uncitable: number;
  /** Set only when a healthy corpus was fully excluded by the caller's filters. */
  excluded_by_filters?: true;
}

/** Fields without which a passage cannot be cited, in report order. */
const CITATION_FIELDS = ['chunk_text', 'title', 'page'] as const;

function firstMissingCitationField(
  payload: Record<string, unknown> | undefined,
): (typeof CITATION_FIELDS)[number] | null {
  if (!payload) return 'chunk_text';
  if (typeof payload.chunk_text !== 'string' || payload.chunk_text.trim() === '') {
    return 'chunk_text';
  }
  if (typeof payload.title !== 'string' || payload.title.trim() === '') return 'title';
  if (!Number.isInteger(payload.page)) return 'page';
  return null;
}

/**
 * Map raw points to the published response shape, dropping anything that
 * cannot be cited.
 *
 * A hit needs verbatim `chunk_text`, a `title`, and an integer `page`;
 * `identifier` and `year` are legitimately null across part of the corpus.
 * `contextual_text` is an LLM-written retrieval aid from ingest — it is
 * returned and labelled as such, never as the source text, because an LLM
 * paraphrase of a standard is not the standard.
 *
 * An all-uncitable batch is a rebuild condition rather than an empty list: the
 * one thing this tool may not do is let a broken library read as "no evidence".
 */
export function toLibraryResult(points: unknown[], scopedCount?: number): LibraryResult {
  const results: LibraryHit[] = [];
  let dropped = 0;
  let firstMissing: string | null = null;

  for (const raw of points) {
    const point = raw as { score?: number; payload?: Record<string, unknown> };
    const missing = firstMissingCitationField(point.payload);
    if (missing) {
      dropped += 1;
      firstMissing ??= missing;
      continue;
    }
    const p = point.payload as Record<string, unknown>;
    results.push({
      title: p.title as string,
      page: p.page as number,
      identifier: (p.identifier as string) ?? null,
      lang: (p.lang as string) ?? null,
      year: (p.year as number) ?? null,
      work_id: (p.decision_id as string) ?? null,
      chunk_text: p.chunk_text as string,
      contextual_text: (p.contextual_text as string) ?? null,
      score: point.score ?? 0,
    });
  }

  if (points.length > 0 && results.length === 0) {
    throw new LibraryError(
      'library_rebuild_required',
      `payload:${firstMissing ?? 'chunk_text'}`,
      'The reference library returned passages that cannot be cited; it needs reingesting.',
    );
  }

  return {
    results,
    dropped_uncitable: dropped,
    ...(points.length === 0 && (scopedCount ?? 0) > 0 ? { excluded_by_filters: true as const } : {}),
  };
}

/**
 * Shared preflight for every library tool.
 *
 * Order is deliberate: configuration, then authorisation, then the operation
 * (which guards the schema before it queries). An unconfigured or unauthorised
 * call produces no cluster traffic, and a broken collection is named before a
 * query can turn its 400 into an empty list.
 *
 * This exists as one function rather than per-tool copies so the R2 guarantee —
 * nothing past preflight escapes the `LibraryError` envelope — is proven once
 * and inherited, instead of being re-implemented (and eventually re-broken) by
 * each new library tool.
 */
export async function withLibrary<T>(
  args: { target_project_id?: string } | undefined,
  configOverride: ServerConfig | undefined,
  op: (client: QdrantLike, libraryProjectId: string) => Promise<T>,
  tool = 'library_search',
): Promise<T> {
  const fileConfig = configOverride ? undefined : ((await loadConfig()) ?? undefined);
  const base = (configOverride ?? (fileConfig as unknown as ServerConfig) ?? {}) as ServerConfig;

  // On stdio the active project is `.valis.json` in the working tree, NOT the
  // `project_id` in the global `~/.valis/config.json` — that is what `valis
  // init` writes and what `serve.ts:38` already treats as authoritative before
  // discarding it at `:104` (gh#334 review R1). Reading the global one instead
  // means a correctly initialised user gets `library_not_configured`, or worse,
  // silently reads a stale project they switched away from.
  //
  // Hosted callers pass a `configOverride` whose `project_id` is already the
  // session's resolved scope, so this lookup is skipped for them entirely.
  const activeProjectId = configOverride
    ? base.project_id
    : ((await findProjectConfig(process.cwd()).catch(() => null))?.project_id ?? base.project_id);

  const config: LibraryInput = {
    ...base,
    library_project_id: resolveLibraryProjectId(args, { project_id: activeProjectId }),
  };

  assertLibraryConfigured(config);
  const libraryProjectId = config.library_project_id;

  // Everything past preflight runs inside one classifier. Client construction
  // and authorisation used to sit outside it, so anything they threw — an
  // unparseable URL, a Supabase client that died on init — reached the SDK as a
  // plain Error with no code and no `missing` (gh#329 review R2). `stage` is
  // what lets one catch name the right failure.
  // Three stages, not two. `getQdrantClient` runs after authorisation has
  // already succeeded, so folding it into the `authorization` stage told an
  // operator that access verification failed when what actually failed was the
  // cluster client (gh#334 review R4). A wrong diagnosis sends them to the
  // wrong system.
  let stage: 'authorization' | 'connect' | 'retrieval' = 'authorization';

  try {
    const supabase = getServiceRoleSupabase(
      config.supabase_url,
      config.supabase_service_role_key,
    );
    await assertLibraryReadable(
      () => resolveReadAccess(supabase, config.member_id, libraryProjectId),
      libraryProjectId,
    );

    // Feature 033 FR-015/SC-005 — a project's owner must be able to observe who
    // read across into it. `valis_search` and `valis_context` already emit this
    // on their cross-org path (`search.ts:242`, `context.ts:305`); a library
    // read is the same act against the same projects and was silently exempt
    // until gh#334 gave it a cross-project path at all.
    //
    // Best-effort by the same rule they follow: an audit failure must not turn
    // a successful read into an error, which is why it carries its own catch
    // rather than falling through to the stage classifier below.
    // Against the RESOLVED active project, not `base.project_id`: on stdio the
    // latter is the global config file, so comparing with it logged a plain
    // read of the user's own `.valis.json` project as a cross-org read.
    if (libraryProjectId !== activeProjectId) {
      try {
        await storeAuditEntry(supabase, {
          id: crypto.randomUUID(),
          org_id: config.org_id,
          project_id: libraryProjectId,
          member_id: config.member_id,
          action: 'cross_org_read',
          target_type: 'project',
          target_id: libraryProjectId,
          previous_state: null,
          new_state: { tool },
          reason: null,
        });
      } catch (err) {
        console.error(
          `[library] audit emit failed for cross_org_read: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    stage = 'connect';
    const client = getQdrantClient(config.qdrant_url, config.qdrant_api_key);
    stage = 'retrieval';

    return await op(client as never, libraryProjectId);
  } catch (err) {
    if (err instanceof LibraryError) throw err;

    if (stage === 'authorization') {
      throw new LibraryError(
        'library_unavailable',
        'authorization',
        'The reference library could not verify access to itself.',
      );
    }

    if (stage === 'connect') {
      throw new LibraryError(
        'library_unavailable',
        'qdrant_client',
        'The reference library could not open a connection to its search cluster.',
      );
    }

    // Qdrant answers a filter on an unindexed field with HTTP 400
    // (`Index required but not found for "X"`). Parsing that message is
    // enrichment only — the schema guard is the authority, so an unrecognised
    // failure stays `library_unavailable` rather than being reclassified on a
    // wording change upstream.
    const message = err instanceof Error ? err.message : String(err);
    const field = /Index required but not found for "?([\w.]+)"?/.exec(message)?.[1];
    if (field) {
      throw new LibraryError(
        'library_rebuild_required',
        `index:${field}`,
        `The reference library needs a payload index on "${field}".`,
      );
    }
    throw new LibraryError(
      'library_unavailable',
      'query_failed',
      'The reference library could not be queried.',
    );
  }
}

/** MCP entry point for `library_search`. */
export async function handleLibrarySearch(
  args: LibrarySearchArgs,
  configOverride?: ServerConfig,
): Promise<LibraryResult> {
  return withLibrary(args, configOverride, async (client, libraryProjectId) => {
    const { points, scopedCount } = await searchLibrary(client, libraryProjectId, args);
    return toLibraryResult(points, scopedCount ?? undefined);
  });
}
