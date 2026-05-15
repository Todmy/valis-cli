import { loadConfig } from '../../config/store.js';
import { resolveConfig } from '../../config/project.js';
import { rerank } from '../../search/reranker.js';
import { suppressResults } from '../../search/suppression.js';
import { incrementUsage } from '../../billing/usage.js';
import { isHostedMode } from '../../cloud/api-url.js';
import { chooseSearchTransport, type SearchTransport } from './search-transport.js';
import {
  buildSearchFilter,
  usedFilterDimensions,
  type DroppedArg,
  type ClampedArg,
  type SearchFilterArgs,
} from '../../search/filter-builder.js';
import { metadataOnlyScroll } from '../../cloud/qdrant/scroll.js';
import { getQdrantClient } from '../../cloud/qdrant.js';
import {
  walkEdges,
  type EdgeType,
  type DecisionEdge,
} from '../../cloud/edge-walker.js';
import {
  getSupabaseClient,
  getSupabaseJwtClient,
  getDecisionsByIds,
} from '../../cloud/supabase.js';
import type {
  SearchResponse,
  RerankedResult,
  ServerConfig,
  ValisConfig,
  SearchExpand,
} from '../../types.js';

interface SearchArgs {
  query: string;
  type?: 'decision' | 'constraint' | 'pattern' | 'lesson';
  limit?: number;
  /** T021: When true, search across all projects the member has access to. */
  all_projects?: boolean;
  /** BUG #161: control return granularity per result. Default 'siblings'. */
  expand?: SearchExpand;
  /**
   * #25/BUG-#118: optional explicit project scope. When supplied AND it
   * differs from the JWT-encoded `project_id`, the response includes a
   * `project_scope_mismatch` signal. Results stay JWT-scoped — the warning
   * is informational, not a hard block.
   */
  project_id?: string;
  // 032/Track 6 — structured filter args. All optional + backward-compatible.
  status?: 'active' | 'proposed' | 'deprecated' | 'superseded';
  min_confidence?: number;
  max_confidence?: number;
  created_after?: string;
  created_before?: string;
  author?: string;
  affects?: string[];
  pinned?: boolean;
  source?: 'mcp_store' | 'file_watcher' | 'stop_hook' | 'seed';
  outcome?: 'success' | 'failed' | 'partial' | 'unknown';
  /**
   * 032/Track 6 — bypass vector search entirely via `qdrant.scroll`. Useful
   * for "list" queries that have no semantic intent — the filter is the
   * whole query. When `semantic` (default) the hybrid search path runs as
   * before.
   */
  query_mode?: 'semantic' | 'metadata_only';
  /**
   * 031/Track 5b — bounded BFS over `decision_edges`. When ≥1, each hit
   * gets a `related` array of neighbours up to `depth` levels deep.
   * Defaults to 0 (no walk, response shape unchanged from pre-slice).
   */
  depth?: 0 | 1 | 2;
  /**
   * 031/Track 5b — payload shape of `related` entries.
   * `summary` (default) returns the minimum useful keys; `full` includes
   * the full neighbour decision body. Has no effect when depth=0.
   */
  mode?: 'summary' | 'full';
  /**
   * 031/Track 5b — optional edge-type filter for the walk. When omitted,
   * all four types (`supersedes`, `builds_on`, `synthesizes`, `contradicts`)
   * are traversed.
   */
  edge_types?: EdgeType[];
}

const DEFAULT_LIMIT = 10;
const SUPPRESSION_THRESHOLD = 1.5;

/**
 * Best-effort usage counter. Failure must never block the search response.
 * Hosted-mode billing is server-side; this only fires for direct transport.
 */
async function tryIncrementUsage(
  config: ValisConfig,
  configOverride?: ServerConfig,
): Promise<void> {
  try {
    const usageApiKey =
      configOverride && config.supabase_service_role_key
        ? config.supabase_service_role_key
        : config.auth_mode === 'jwt'
          ? config.member_api_key || config.api_key
          : config.supabase_service_role_key;
    await incrementUsage(
      config.supabase_url,
      usageApiKey,
      config.org_id,
      'search',
      config.auth_mode,
    );
  } catch {
    // Usage increment failure must never block search operations.
  }
}

export async function handleSearch(
  args: SearchArgs,
  configOverride?: ServerConfig,
): Promise<SearchResponse> {
  const config = (configOverride ?? (await loadConfig())) as ValisConfig | null;
  if (!config) {
    return { results: [], note: 'Not configured. Run `valis init` first.' };
  }

  // T021: Resolve project from per-directory config when stdio CLI; HTTP MCP
  // passes project_id via configOverride.
  const resolved = configOverride ? null : await resolveConfig();
  const projectId = configOverride?.project_id || resolved?.project?.project_id || undefined;

  const isHostedProxy = config.auth_mode === 'jwt' && isHostedMode(config);

  // 032/Track 6 — structured filter translation. Always run; produces empty
  // filter when no new args supplied (FR-013 backward compat).
  const filterArgs: SearchFilterArgs = {
    type: args.type,
    status: args.status,
    min_confidence: args.min_confidence,
    max_confidence: args.max_confidence,
    created_after: args.created_after,
    created_before: args.created_before,
    author: args.author,
    affects: args.affects,
    pinned: args.pinned,
    source: args.source,
    outcome: args.outcome,
  };
  const filterBuild = buildSearchFilter(filterArgs);
  const filterDimensions = usedFilterDimensions(filterArgs);

  // 032/Track 6 — metadata_only mode bypasses the embedding pipeline.
  if (args.query_mode === 'metadata_only') {
    return runMetadataOnlySearch({
      args,
      config,
      configOverride,
      projectId,
      filter: filterBuild.filter,
      dropped_args: filterBuild.dropped_args,
      clamped_args: filterBuild.clamped_args,
      filter_dim_used: filterDimensions,
    });
  }

  const transport: SearchTransport = chooseSearchTransport(config, configOverride);

  let enriched;
  try {
    enriched = await transport.search(args.query, {
      type: args.type,
      projectId,
      all_projects: args.all_projects,
      expand: args.expand,
      payload_filter: filterBuild.filter.must.length > 0 ? filterBuild.filter : undefined,
    });
  } catch (err) {
    const tag = isHostedProxy ? 'Proxy' : 'Qdrant';
    console.error(
      `[search] ${tag} error: ${err instanceof Error ? err.stack || err.message : String(err)}`,
    );
    return { results: [], offline: true, note: 'Cloud unavailable. Search offline.' };
  }

  const reranked: RerankedResult[] = rerank(enriched);
  const { visible, suppressed_count } = suppressResults(reranked, SUPPRESSION_THRESHOLD, false);
  const baseResults = visible.slice(0, args.limit ?? DEFAULT_LIMIT);

  // 031/Track 5b — enrich with typed-edge neighbours when depth >= 1.
  // Non-blocking (Constitution III): a failure here downgrades each hit's
  // `related` array to [] but never breaks the parent search response.
  const finalResults = await enrichWithRelated(baseResults, args, config);

  // Hosted-proxy mode: server-side /api/search already increments usage.
  // Direct mode: client-side billing.
  if (!isHostedProxy) {
    await tryIncrementUsage(config, configOverride);
  }

  const mismatch = detectScopeMismatch(args.project_id, configOverride);
  return assembleResponse({
    results: finalResults,
    suppressed_count,
    mismatch,
    dropped_args: filterBuild.dropped_args,
    clamped_args: filterBuild.clamped_args,
    filter_dim_used: filterDimensions,
  });
}

interface MetadataOnlyArgs {
  args: SearchArgs;
  config: ValisConfig;
  configOverride: ServerConfig | undefined;
  projectId: string | undefined;
  filter: ReturnType<typeof buildSearchFilter>['filter'];
  dropped_args: DroppedArg[];
  clamped_args: ClampedArg[];
  filter_dim_used: ReturnType<typeof usedFilterDimensions>;
}

async function runMetadataOnlySearch(p: MetadataOnlyArgs): Promise<SearchResponse> {
  const { args, config, configOverride, projectId } = p;
  let results;
  try {
    const qdrant = getQdrantClient(config.qdrant_url, config.qdrant_api_key);
    results = await metadataOnlyScroll(qdrant, {
      orgId: config.org_id,
      projectId,
      filter: p.filter,
      limit: args.limit ?? DEFAULT_LIMIT,
    });
  } catch (err) {
    console.error(
      `[search] metadata_only error: ${err instanceof Error ? err.message : String(err)}`,
    );
    return assembleResponse({
      results: [],
      suppressed_count: 0,
      mismatch: detectScopeMismatch(args.project_id, configOverride),
      offline: true,
      note: 'Cloud unavailable. Search offline.',
      dropped_args: p.dropped_args,
      clamped_args: p.clamped_args,
      filter_dim_used: p.filter_dim_used,
    });
  }

  const mismatch = detectScopeMismatch(args.project_id, configOverride);
  const isHostedProxy = config.auth_mode === 'jwt' && isHostedMode(config);
  if (!isHostedProxy) {
    await tryIncrementUsage(config, configOverride);
  }
  const modeNote: 'query_string_ignored_in_metadata_mode' | undefined =
    args.query && args.query.trim().length > 0
      ? 'query_string_ignored_in_metadata_mode'
      : undefined;
  return assembleResponse({
    results,
    suppressed_count: 0,
    mismatch,
    mode_note: modeNote,
    dropped_args: p.dropped_args,
    clamped_args: p.clamped_args,
    filter_dim_used: p.filter_dim_used,
  });
}

interface AssembleArgs {
  results: RerankedResult[];
  suppressed_count: number;
  mismatch: ReturnType<typeof detectScopeMismatch>;
  offline?: boolean;
  note?: string;
  mode_note?: 'query_string_ignored_in_metadata_mode';
  dropped_args: DroppedArg[];
  clamped_args: ClampedArg[];
  filter_dim_used: ReturnType<typeof usedFilterDimensions>;
}

function assembleResponse(p: AssembleArgs): SearchResponse {
  const response: SearchResponse = { results: p.results };
  if (p.suppressed_count > 0) response.suppressed_count = p.suppressed_count;
  if (p.offline) response.offline = true;
  if (p.note) response.note = p.note;
  if (p.mode_note) response.mode_note = p.mode_note;
  if (p.mismatch) response.project_scope_mismatch = p.mismatch;
  if (p.dropped_args.length > 0) response.dropped_args = p.dropped_args;
  if (p.clamped_args.length > 0) response.clamped_args = p.clamped_args;
  if (p.filter_dim_used.length > 0) {
    response.filter_dim_used = [...p.filter_dim_used];
  }
  return response;
}

/**
 * #25/BUG-#118: surface a structured warning when the per-call `project_id`
 * arg differs from the JWT-encoded session scope. Returns null in CLI stdio
 * mode (no JWT scope to mismatch against) and on exact match.
 */
function detectScopeMismatch(
  argProjectId: string | undefined,
  configOverride: ServerConfig | undefined,
): { session_project_id: string; current_project_id: string; action_required: 'restart_session' } | null {
  if (!argProjectId || !configOverride?.project_id) return null;
  if (argProjectId === configOverride.project_id) return null;
  return {
    session_project_id: configOverride.project_id,
    current_project_id: argProjectId,
    action_required: 'restart_session',
  };
}

/**
 * 031/Track 5b — enrich each search hit with the `related` neighbourhood
 * up to `depth` levels deep over `decision_edges`. Returns the input
 * unchanged when depth=0 or omitted (backward-compat per FR-010).
 *
 * Non-blocking: any failure of the walker or summary lookup downgrades the
 * affected hits' `related` array to `[]` and logs. The parent search still
 * returns its hits.
 */
async function enrichWithRelated(
  results: RerankedResult[],
  args: SearchArgs,
  config: ValisConfig,
): Promise<RerankedResult[]> {
  const depth = args.depth ?? 0;
  if (depth === 0) return results; // FR-010 — no field added, byte-identical response
  if (depth !== 1 && depth !== 2) {
    // FR-014 — defence in depth: walker also rejects, but reject here too
    // so a bogus value never reaches the BFS.
    console.warn(`[search] invalid depth ${depth}; falling back to depth=0`);
    return results;
  }
  if (results.length === 0) return results;

  const rootIds = results.map((r) => r.id);
  const supabase =
    config.auth_mode === 'jwt'
      ? getSupabaseJwtClient(config.supabase_url, config.member_api_key || config.api_key)
      : getSupabaseClient(config.supabase_url, config.supabase_service_role_key);

  try {
    const loader = async (
      fromIds: string[],
      edgeTypes: EdgeType[] | undefined,
    ): Promise<DecisionEdge[]> => {
      let query = supabase
        .from('decision_edges')
        .select('from_id, to_id, type, reason')
        .eq('org_id', config.org_id)
        .in('from_id', fromIds);
      if (edgeTypes && edgeTypes.length > 0) {
        query = query.in('type', edgeTypes);
      }
      const { data, error } = await query;
      if (error) throw new Error(`decision_edges query failed: ${error.message}`);
      return (data ?? []) as DecisionEdge[];
    };

    const neighborhoods = await walkEdges(rootIds, { depth, edgeTypes: args.edge_types }, loader);

    // Collect unique neighbour ids for the summary join. Summary mode is the
    // default; `mode: 'full'` is opt-in for the heavier payload (FR-011).
    const allNeighbourIds = new Set<string>();
    for (const nh of neighborhoods) {
      for (const n of nh.neighbours) allNeighbourIds.add(n.decision_id);
    }
    const summaries = new Map<string, string | null>();
    if (allNeighbourIds.size > 0) {
      try {
        const rows = await getDecisionsByIds(
          supabase,
          config.org_id,
          Array.from(allNeighbourIds),
        );
        for (const r of rows) {
          summaries.set(r.id, (r as { summary?: string | null }).summary ?? null);
        }
      } catch (err) {
        console.warn(
          `[search] summary lookup failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // Build the per-root map for fast assembly.
    const byRoot = new Map(
      neighborhoods.map((nh) => [nh.root_id, nh.neighbours] as const),
    );
    const wantFull = args.mode === 'full';
    return results.map((r) => {
      const neighbours = byRoot.get(r.id) ?? [];
      const related = neighbours.map((n) => ({
        decision_id: n.decision_id,
        edge_type: n.edge_type,
        depth: n.depth,
        reason: n.reason,
        ...(wantFull
          ? {}
          : { summary: summaries.get(n.decision_id) ?? null }),
      }));
      return { ...r, related };
    });
  } catch (err) {
    console.warn(
      `[search] edge-walk failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    // Constitution III — every hit gets related:[] so callers can rely on
    // the field's presence whenever depth>=1.
    return results.map((r) => ({ ...r, related: [] }));
  }
}
