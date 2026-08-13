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

import type { ServerConfig, ValisConfig } from '../../types.js';
import type { ReadAccess } from '../../lib/project-access.js';

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
 * Resolve the project that owns the reference library. Server-side only, in
 * three steps, first hit wins.
 *
 * Step 2 and 3 exist because `startMcpServer()` calls `createMcpServer()` with
 * no `ServerConfig` (`server.ts:916`) — without a stdio source the tool would
 * be advertised on that transport while being able to answer only
 * `library_not_configured`, which is an API promise with no implementation.
 *
 * Never a tool argument: a caller-supplied project id would turn a scoped
 * library read into arbitrary cross-project retrieval.
 */
export function resolveLibraryProjectId(
  serverConfig?: ServerConfig,
  fileConfig?: Partial<ValisConfig>,
): string | undefined {
  return (
    serverConfig?.library_project_id
    ?? fileConfig?.library_project_id
    ?? process.env.VALIS_LIBRARY_PROJECT_ID
    ?? undefined
  );
}

/** Credentials the handler cannot proceed without, in report order. */
type LibraryConfig = ServerConfig & { library_project_id: string };

/**
 * Fail before any network call when the tool cannot possibly succeed, naming
 * the field that is absent. An installation with no library is a valid
 * installation — `library_not_configured` is an honest state, not a defect —
 * so this is reported, never repaired.
 */
export function assertLibraryConfigured(
  config: ServerConfig | undefined,
): asserts config is LibraryConfig {
  const missing = ([
    ['library_project_id', config?.library_project_id],
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
