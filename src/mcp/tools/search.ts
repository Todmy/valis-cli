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
import { getQdrantClient, mmrRerank } from '../../cloud/qdrant.js';
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
import { storeAuditEntry } from '../../cloud/supabase/audit.js';
import { resolveProposedPendingBlock } from './proposed-pending-block.js';
import { canReadProject } from '../../lib/project-access.js';
import {
  buildScopeEnvelope,
  buildScopeHint,
  buildScopeInputs,
  type ScopeInputs,
} from './scope.js';
import { record as recordTelemetry } from '../../hooks/telemetry.js';
import {
  type SearchResponse,
  type RerankedResult,
  type ScopeEnvelope,
  type ServerConfig,
  type ValisConfig,
  type SearchExpand,
  type ProposedPending,
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
  /**
   * Feature 033 — cross-org public-KB read. When set, the search targets
   * a project that may differ from the caller's JWT scope. Access is
   * resolved at request time via `is-member-of(target) OR is-public(target)`.
   * Denied → empty result set indistinguishable from "no results" /
   * "project does not exist" (FR-006). Members searching their own
   * project should leave this undefined to preserve legacy behaviour.
   */
  target_project_id?: string;
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
  //
  // 2026-05-21 fix (cross-project leak): args.project_id is now consulted
  // as a fallback when neither configOverride nor .valis.json carries a
  // scope. Without this, plugin OAuth tokens that lack a project claim
  // resolve to `undefined`, and `buildProjectFilter(orgId, undefined)`
  // returns org-wide results — leaking decisions from other projects in
  // the same org. The plugin's UserPromptSubmit hook explicitly injects
  // `pass project_id explicitly in args` into the agent context, so this
  // restores honesty between the documented behaviour and the actual
  // filter scope. When configOverride already has a scope and args.
  // project_id differs, `detectScopeMismatch` still raises the warning
  // (configOverride wins, args is diagnostic) — that contract is
  // preserved below.
  const resolved = configOverride ? null : await resolveConfig();
  let projectId =
    configOverride?.project_id ||
    resolved?.project?.project_id ||
    args.project_id ||
    undefined;

  // Fail-closed on missing scope (2026-05-21). When the caller hasn't
  // supplied a project_id from ANY source (JWT, .valis.json, args)
  // AND hasn't opted into cross-project search, we surface a
  // structured error rather than fall through to an org-wide query
  // that leaks across projects. The error is shaped so the agent can
  // read it as a hint to ask the user which project to use.
  if (!projectId && !args.all_projects && !args.target_project_id) {
    return {
      results: [],
      error: 'project_scope_required',
      note:
        'No project scope. Ask the user which project to search, then pass ' +
        '`project_id` explicitly in args. To search across every project the ' +
        'member can access, pass `all_projects: true`.',
    };
  }

  // 040/#226 — track whether this call resolved to a cross-org public-KB read.
  // The `proposed_pending` block is member-only triage authority, so it is
  // OMITTED for cross-org reads (FR-006).
  let isCrossOrgRead = false;
  // Feature 033 — public-KB cross-org read gate. When `target_project_id`
  // is set, replace `projectId` with the target after access resolution.
  // Denied access returns an empty response indistinguishable from "no
  // results" / "project does not exist" (FR-006, never leaks existence).
  if (args.target_project_id && args.target_project_id !== projectId) {
    isCrossOrgRead = true;
    if (!configOverride?.member_id || !configOverride?.supabase_url || !configOverride?.supabase_service_role_key) {
      // stdio mode or insufficient creds — cross-org reads only work in HTTP
      // (plugin) mode where the server holds service-role auth. Deny silently.
      return { results: [] };
    }
    const supabaseAdmin = getSupabaseClient(
      configOverride.supabase_url,
      configOverride.supabase_service_role_key,
    );
    const granted = await canReadProject(
      supabaseAdmin,
      configOverride.member_id,
      args.target_project_id,
    );
    if (!granted) {
      return { results: [] };
    }
    projectId = args.target_project_id;

    // Feature 033 — audit the cross-org read so the target project's owner can
    // observe who is reading their public KB (FR-015, SC-005). Best-effort:
    // failure must never block the search response (Constitution III).
    try {
      await storeAuditEntry(supabaseAdmin, {
        id: crypto.randomUUID(),
        org_id: configOverride.org_id,
        project_id: args.target_project_id,
        member_id: configOverride.member_id,
        action: 'cross_org_read',
        target_type: 'project',
        target_id: args.target_project_id,
        previous_state: null,
        new_state: { tool: 'valis_search' },
        reason: null,
      });
    } catch (err) {
      console.error(
        `[search] audit emit failed for cross_org_read: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

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
      isCrossOrgRead,
    });
  }

  const transport: SearchTransport = chooseSearchTransport(config, configOverride);

  let enriched;
  // finding #2 — the proxy transport returns the server-computed draft-backlog
  // block alongside the results; capture it so we can reuse it verbatim and
  // skip the client-side COUNT recompute below.
  let serverProposedPending: ProposedPending | undefined;
  try {
    const transportResult = await transport.search(args.query, {
      type: args.type,
      projectId,
      all_projects: args.all_projects,
      expand: args.expand,
      payload_filter: filterBuild.filter.must.length > 0 ? filterBuild.filter : undefined,
    });
    enriched = transportResult.results;
    serverProposedPending = transportResult.proposed_pending;
  } catch (err) {
    const tag = isHostedProxy ? 'Proxy' : 'Qdrant';
    console.error(
      `[search] ${tag} error: ${err instanceof Error ? err.stack || err.message : String(err)}`,
    );
    return { results: [], offline: true, note: 'Cloud unavailable. Search offline.' };
  }

  const reranked: RerankedResult[] = rerank(enriched);
  const { visible, suppressed_count } = suppressResults(reranked, SUPPRESSION_THRESHOLD, false);
  // 037 (issue #120, PR #228 review): MMR diversity is the FINAL transform —
  // applied AFTER rerank + suppression, at the user's display limit, over the
  // reranked composite_score. This is the only place the diversified ordering
  // is computed for valis_search (mid-pipeline MMR was a no-op because rerank
  // re-sorted by composite_score afterwards). The diversified top-K survives to
  // the agent. Scroll-fallback / zero-gradient pools short-circuit inside mmrRerank.
  const baseResults = mmrRerank(visible, {
    k: args.limit ?? DEFAULT_LIMIT,
    relevanceOf: (r) => (r as RerankedResult).composite_score ?? r.score ?? 0,
  });

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
  // 039/#94 — best-effort scope assembly via the shared helper (finding #6).
  // When `projectId` resolved we name it; when the caller opted into
  // `all_projects` with no single scope (finding #2) the helper still emits a
  // scope with `active_project: null` + the accessible-project list.
  const scope = await buildScopeInputs(
    config,
    configOverride,
    projectId,
    args.all_projects === true,
  );
  // 040/#226 — best-effort draft-backlog block.
  // finding #2 — on the hosted-proxy path `/api/search` already computed this
  // block server-side (service-role + explicit org_id+project_id filter). Reuse
  // it verbatim instead of issuing the COUNT fan-out a second time client-side.
  // Direct mode (`serverProposedPending` undefined) computes it in-process,
  // reusing the already-ranked result scores for `top_3.similarity` (FR-010).
  let proposed_pending: ProposedPending | undefined;
  if (isHostedProxy) {
    proposed_pending = serverProposedPending;
  } else {
    const similarityById = new Map<string, number>();
    for (const r of finalResults) {
      if (typeof r.score === 'number') similarityById.set(r.id, r.score);
    }
    proposed_pending = await buildProposedPendingBlock({
      config,
      configOverride,
      args,
      projectId,
      isCrossOrgRead,
      similarityById,
    });
  }
  return emitRecallTelemetryAndReturn(
    assembleResponse({
      results: finalResults,
      suppressed_count,
      mismatch,
      dropped_args: filterBuild.dropped_args,
      clamped_args: filterBuild.clamped_args,
      filter_dim_used: filterDimensions,
      scope,
      proposed_pending,
    }),
    config.org_id,
    'valis_search',
  );
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
  /** 040/#226 — true when the call resolved to a cross-org public-KB read. */
  isCrossOrgRead: boolean;
}

async function runMetadataOnlySearch(p: MetadataOnlyArgs): Promise<SearchResponse> {
  const { args, config, configOverride, projectId } = p;
  // 039/#94 — resolve scope once; reused across the error + success returns.
  const scope = await buildScopeInputs(
    config,
    configOverride,
    projectId,
    args.all_projects === true,
  );
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
      scope,
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
  // 040/#226 — metadata-only path has no semantic score, so `top_3.similarity`
  // is null for every entry (FR-004). Best-effort; omitted on any error.
  const proposed_pending = await buildProposedPendingBlock({
    config,
    configOverride,
    args,
    projectId,
    isCrossOrgRead: p.isCrossOrgRead,
  });
  return assembleResponse({
    results,
    suppressed_count: 0,
    mismatch,
    mode_note: modeNote,
    dropped_args: p.dropped_args,
    clamped_args: p.clamped_args,
    filter_dim_used: p.filter_dim_used,
    scope,
    proposed_pending,
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
  /**
   * 039/#94 — scope inputs. When present, `assembleResponse` builds the
   * `scope` envelope (FR-001) and the optional empty-result `scope_hint`
   * (FR-005/FR-006). Omitted only on the `project_scope_required` fail-closed
   * path where there is no project to name AND the query did not span all.
   */
  scope?: ScopeInputs;
  /**
   * 040/#226 — pre-built draft-backlog block, or undefined to OMIT it (FR-006).
   * Independent top-level key; never overwrites the 039 `scope` envelope (FR-008).
   */
  proposed_pending?: ProposedPending;
}

/**
 * 034 / FR-018: emit one `recall_hit` telemetry event per result returned.
 * Backs SC-006 quality clause (mean recall_hit.score per project_id ≥95%
 * of pre-deletion baseline). Best-effort; never blocks the response.
 * Helper is intentionally side-effect-only — pass through the response so
 * call-sites can chain `return emitRecallTelemetryAndReturn(response, ...)`.
 */
function emitRecallTelemetryAndReturn(
  response: SearchResponse,
  orgId: string,
  source: 'valis_search' | 'valis_context',
): SearchResponse {
  try {
    for (const r of response.results) {
      // SearchResponse.results is typed as SearchResult; in this code path
      // finalResults is actually RerankedResult, which adds composite_score.
      // Read via a narrowed cast — `score` is the public field on the base
      // SearchResult, composite_score is the reranker's enriched signal.
      const score =
        (r as unknown as { composite_score?: number }).composite_score ?? r.score ?? 0;
      void recordTelemetry('recall_hit', {
        org_id: orgId,
        project_id: r.project_id ?? '',
        metadata: {
          decision_id: r.id,
          score,
          source_tool: source,
        },
      });
    }
  } catch {
    /* never block the response */
  }
  return response;
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
  // 039/#94 — attach the scope envelope + optional empty-result hint.
  // Independent top-level keys (FR-009/FR-010); never overwrite existing
  // fields. Skipped on the no-active-project fail-closed path.
  if (p.scope) {
    const scope: ScopeEnvelope = buildScopeEnvelope({
      activeProjectId: p.scope.activeProjectId,
      accessibleProjects: p.scope.accessibleProjects,
      queriedAllProjects: p.scope.queriedAllProjects,
    });
    response.scope = scope;
    // finding #3 — count suppressed hits as "not empty": a project with
    // matching decisions all below the suppression threshold has NOT decided
    // nothing, so the cross-project-retry hint must not fire.
    const hint = buildScopeHint(
      p.results.length,
      scope.accessible_projects.length,
      scope.queried_all_projects,
      p.suppressed_count,
    );
    if (hint) response.scope_hint = hint;
  }
  // 040/#226 — attach the draft-backlog block when present. Omission (undefined)
  // is the honest signal on offline / cross-project / cross-org / failure paths.
  if (p.proposed_pending) response.proposed_pending = p.proposed_pending;
  return response;
}

/**
 * 040/#226 — build the `proposed_pending` draft-backlog block for the active
 * project. Thin adapter over the shared `resolveProposedPendingBlock`
 * (finding #8) — maps `SearchArgs.all_projects` into the shared input shape.
 */
function buildProposedPendingBlock(p: {
  config: ValisConfig;
  configOverride: ServerConfig | undefined;
  args: SearchArgs;
  projectId: string | undefined;
  isCrossOrgRead: boolean;
  similarityById?: Map<string, number>;
}): Promise<ProposedPending | undefined> {
  return resolveProposedPendingBlock({
    config: p.config,
    configOverride: p.configOverride,
    allProjects: p.args.all_projects,
    projectId: p.projectId,
    isCrossOrgRead: p.isCrossOrgRead,
    similarityById: p.similarityById,
  });
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
