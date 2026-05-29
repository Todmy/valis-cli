import { loadConfig } from '../../config/store.js';
import { resolveConfig } from '../../config/project.js';
import { getQdrantClient, hybridSearch, hybridSearchAllProjects, mmrRerank } from '../../cloud/qdrant.js';
import { getSupabaseClient, listMemberProjects } from '../../cloud/supabase.js';
import { proxySearch } from '../../cloud/search-proxy.js';
import { resolveProposedPendingBlock } from './proposed-pending-block.js';
import { isHostedMode } from '../../cloud/api-url.js';
import { rerank } from '../../search/reranker.js';
import { suppressResults } from '../../search/suppression.js';
import { canReadProject } from '../../lib/project-access.js';
import { storeAuditEntry } from '../../cloud/supabase/audit.js';
import {
  buildScopeEnvelope,
  buildScopeHint,
  buildScopeInputs,
  selectMemberSupabaseClient,
  type AccessibleProject,
  type ScopeInputs,
} from './scope.js';
import { record as recordTelemetry } from '../../hooks/telemetry.js';
import {
  type ContextResponse,
  type RerankedResult,
  type DecisionStatus,
  type ServerConfig,
  type ValisConfig,
} from '../../types.js';

/** Per-bucket display cap for grouped context results. */
const CONTEXT_BUCKET_LIMIT = 20;

/**
 * 037 (issue #120, PR #228 review): apply MMR diversity as the FINAL transform
 * on an already-reranked, grouped bucket — at the bucket's display limit, over
 * the reranked `composite_score`. Replaces the plain `.slice(0, 20)` so the
 * diversified ordering survives to the agent (mid-pipeline MMR in hybridSearch
 * was a no-op once `rerank()` re-sorted by composite_score). Zero-gradient
 * pools short-circuit inside mmrRerank (finding 3).
 */
function diversifyBucket(bucket: RerankedResult[]): RerankedResult[] {
  return mmrRerank(bucket, {
    k: CONTEXT_BUCKET_LIMIT,
    relevanceOf: (r) => r.composite_score ?? r.score ?? 0,
  });
}

/**
 * 034 / FR-018: emit one `recall_hit` telemetry event per result returned
 * across all four grouped buckets (decisions/constraints/patterns/lessons)
 * plus `historical`. Backs SC-006 quality clause. Helper threads through
 * the response so call-sites can chain `return emitAndReturn(response, ...)`.
 */
function emitRecallTelemetryAndReturn(
  response: ContextResponse,
  orgId: string,
): ContextResponse {
  try {
    const buckets = [
      response.decisions,
      response.constraints,
      response.patterns,
      response.lessons,
      response.historical ?? [],
    ];
    for (const bucket of buckets) {
      if (!bucket) continue;
      for (const r of bucket) {
        const score =
          (r as unknown as { composite_score?: number }).composite_score ??
          (r as unknown as { score?: number }).score ??
          0;
        void recordTelemetry('recall_hit', {
          org_id: orgId,
          project_id: (r as unknown as { project_id?: string }).project_id ?? '',
          metadata: {
            decision_id: r.id,
            score,
            source_tool: 'valis_context',
          },
        });
      }
    }
  } catch {
    /* never block the response */
  }
  return response;
}

/**
 * 039/#94 — attach the `scope` envelope + optional empty-result `scope_hint`
 * to a context response. "Empty" for the hint counts results across the four
 * active buckets only (decisions + constraints + patterns + lessons);
 * `historical` (superseded/deprecated) is excluded — those are not "results"
 * for the cross-project-retry advisory (FR-005). Additive, independent
 * top-level keys (FR-009/FR-010).
 */
function attachScope(
  base: ContextResponse,
  scopeInputs: ScopeInputs,
): ContextResponse {
  const scope = buildScopeEnvelope(scopeInputs);
  const resultCount =
    base.decisions.length +
    base.constraints.length +
    base.patterns.length +
    base.lessons.length;
  // finding #3 — agree with search.ts: a project whose only matches were
  // suppressed is NOT empty. Gate the hint on visible + suppressed both zero.
  const hint = buildScopeHint(
    resultCount,
    scope.accessible_projects.length,
    scope.queried_all_projects,
    base.suppressed_count ?? 0,
  );
  return hint ? { ...base, scope, scope_hint: hint } : { ...base, scope };
}

/**
 * 040/#226 — attach the `proposed_pending` draft-backlog block to a context
 * response. Thin adapter over the shared `resolveProposedPendingBlock`
 * (finding #8): when the block resolves it is attached additively; when the
 * shared helper OMITS it (cross-project / cross-org / no project / COUNT
 * failure — FR-006) the response is returned unchanged.
 */
async function attachProposedPending(
  base: ContextResponse,
  p: {
    config: ValisConfig;
    configOverride: ServerConfig | undefined;
    args: ContextArgs;
    projectId: string | undefined;
    isCrossOrgRead: boolean;
    similarityById?: Map<string, number>;
  },
): Promise<ContextResponse> {
  const block = await resolveProposedPendingBlock({
    config: p.config,
    configOverride: p.configOverride,
    allProjects: p.args.all_projects,
    projectId: p.projectId,
    isCrossOrgRead: p.isCrossOrgRead,
    similarityById: p.similarityById,
  });
  return block ? { ...base, proposed_pending: block } : base;
}

interface ContextArgs {
  task_description: string;
  files?: string[];
  /** T022: When true, load context from all accessible projects. */
  all_projects?: boolean;
  /**
   * #25/BUG-#118: optional explicit project scope. When supplied AND differs
   * from the JWT-encoded session scope, the response includes a
   * `project_scope_mismatch` signal. Informational — results stay JWT-scoped.
   */
  project_id?: string;
  /**
   * Feature 033 — cross-org public-KB read. When set, context loads from
   * a project that may differ from the caller's JWT scope. Access
   * resolution: `is-member-of(target) OR is-public(target)`. Denied →
   * empty context indistinguishable from "no decisions" / "project does
   * not exist" (FR-006). Members loading their own context should leave
   * this undefined to preserve legacy behaviour.
   */
  target_project_id?: string;
}

/**
 * 039/#94 / finding #4 — fetch the member's project list ONCE for scope
 * assembly so the proxy branch (default for all plugin users) does not issue a
 * second `listMemberProjects` RPC. Returns `undefined` when no usable creds /
 * member_id (CLI stdio, missing service role) so the downstream scope helper
 * falls back to its own gated lookup + active-project naming. Best-effort:
 * any failure degrades to `undefined`, never throws (Constitution III).
 */
async function prefetchMemberships(
  config: ValisConfig,
  configOverride: ServerConfig | undefined,
): Promise<AccessibleProject[] | undefined> {
  if (!config.member_id) return undefined;
  const client = selectMemberSupabaseClient(config, configOverride);
  if (!client) return undefined;
  try {
    const projects = await listMemberProjects(client.supabase, config.member_id);
    return projects.map((p) => ({ id: p.id, name: p.name }));
  } catch {
    return undefined;
  }
}

/** Statuses considered non-active (historical). */
const HISTORICAL_STATUSES: Set<DecisionStatus> = new Set(['deprecated', 'superseded']);

let firstCall = true;

export async function handleContext(args: ContextArgs, configOverride?: ServerConfig): Promise<ContextResponse> {
  const config = (configOverride ?? await loadConfig()) as ValisConfig | null;

  // #25/BUG-#118: compute scope mismatch once; every return spreads it in.
  // Null in CLI stdio mode (no JWT scope to mismatch against) or on exact match.
  const scopeMismatch =
    args.project_id && configOverride?.project_id && args.project_id !== configOverride.project_id
      ? {
          session_project_id: configOverride.project_id,
          current_project_id: args.project_id,
          action_required: 'restart_session' as const,
        }
      : null;
  const withMismatch = (base: ContextResponse): ContextResponse =>
    scopeMismatch ? { ...base, project_scope_mismatch: scopeMismatch } : base;

  if (!config) {
    return withMismatch({
      decisions: [],
      constraints: [],
      patterns: [],
      lessons: [],
      historical: [],
      total_in_brain: 0,
      note: 'Not configured. Run `valis init` first.',
    });
  }

  // Build query from task description + file names
  let query = args.task_description;
  if (args.files?.length) {
    const fileTerms = args.files
      .map((f) => f.split('/').pop()?.replace(/\.[^.]+$/, ''))
      .filter(Boolean)
      .join(' ');
    query = `${query} ${fileTerms}`;
  }

  // T022: Resolve project from per-directory config.
  // 2026-05-21: args.project_id is the third source (plugin-OAuth path,
  // see handleSearch for full rationale).
  const resolved = configOverride ? null : await resolveConfig();
  let projectId =
    configOverride?.project_id ||
    resolved?.project?.project_id ||
    args.project_id;

  // 040/#226 — track a cross-org public-KB read; the draft-backlog block is
  // member-only triage authority, so it is OMITTED for cross-org reads (FR-006).
  let isCrossOrgRead = false;
  // Feature 033 — public-KB cross-org gate. Mirrors handleSearch.
  if (args.target_project_id && args.target_project_id !== projectId) {
    isCrossOrgRead = true;
    if (
      !configOverride?.member_id ||
      !configOverride?.supabase_url ||
      !configOverride?.supabase_service_role_key
    ) {
      return withMismatch({
        decisions: [],
        constraints: [],
        patterns: [],
        lessons: [],
        historical: [],
        total_in_brain: 0,
      });
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
      return withMismatch({
        decisions: [],
        constraints: [],
        patterns: [],
        lessons: [],
        historical: [],
        total_in_brain: 0,
      });
    }
    projectId = args.target_project_id;

    // Feature 033 — audit the cross-org read (FR-015, SC-005). Best-effort.
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
        new_state: { tool: 'valis_context' },
        reason: null,
      });
    } catch (err) {
      console.error(
        `[context] audit emit failed for cross_org_read: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // Q8: Route through server-side proxy in hosted mode (no direct Qdrant access)
  if (config.auth_mode === 'jwt' && isHostedMode(config)) {
    try {
      // finding #2 — the proxy now returns the server-computed draft-backlog
      // block alongside the results; capture it so the hosted-proxy path reuses
      // it verbatim instead of recomputing the COUNT fan-out client-side.
      const { results: proxyResults, proposed_pending: serverProposedPending } =
        await proxySearch(config, query, {
          limit: 50,
          project_id: projectId ?? undefined,
          all_projects: args.all_projects,
          member_id: config.member_id ?? undefined,
        });

      // Apply reranking + suppression
      const reranked: RerankedResult[] = rerank(proxyResults);
      const { visible, suppressed_count } = suppressResults(reranked, 1.5, false);

      // Separate active/proposed from deprecated/superseded
      const active: RerankedResult[] = [];
      const historical: RerankedResult[] = [];
      for (const r of visible) {
        const status: DecisionStatus = r.status || 'active';
        if (HISTORICAL_STATUSES.has(status)) {
          historical.push(r);
        } else {
          active.push(r);
        }
      }

      // Group active results by type
      const grouped: Record<string, RerankedResult[]> = {
        decision: [], constraint: [], pattern: [], lesson: [],
      };
      for (const r of active) {
        const type = r.type === 'pending' ? 'decision' : r.type;
        if (grouped[type]) grouped[type].push(r);
      }

      const totalInBrain = reranked.length;
      let note: string | undefined;
      if (firstCall) {
        const historicalNote = historical.length > 0
          ? ` (${historical.length} historical/superseded items also available)` : '';
        const suppressedNote = suppressed_count > 0
          ? ` (${suppressed_count} similar results suppressed)` : '';
        note = `${totalInBrain} relevant decisions found in team brain${historicalNote}${suppressedNote}. Use valis_search for specific queries.`;
        firstCall = false;
      }

      // #228 — MMR diversity stays the FINAL bucket transform on the proxy
      // path; diversifyBucket replaces the plain `.slice(0, 20)`.
      const proxyBase = withMismatch({
        decisions: diversifyBucket(grouped.decision),
        constraints: diversifyBucket(grouped.constraint),
        patterns: diversifyBucket(grouped.pattern),
        lessons: diversifyBucket(grouped.lesson),
        historical,
        total_in_brain: totalInBrain,
        suppressed_count,
        note,
      });
      // 040/#226 — draft-backlog block on the hosted-proxy path.
      // finding #2 — `/api/search` already computed this block server-side
      // (service-role + explicit org_id+project_id filter). Reuse it verbatim
      // rather than recomputing the COUNT fan-out client-side. The same FR-006
      // omission rules apply server-side, so `undefined` here is the honest
      // signal for cross-project / cross-org / no-scope / COUNT-failure.
      const proxyBaseWithDrafts: ContextResponse = serverProposedPending
        ? { ...proxyBase, proposed_pending: serverProposedPending }
        : proxyBase;
      // 039/#94 — scope envelope on the hosted-proxy path (the default for all
      // plugin users). finding #4 / FR-011: prefetch the membership list ONCE
      // here and thread it into the scope assembly so the proxy branch does
      // not issue a second `listMemberProjects` RPC per call. finding #2: when
      // `all_projects` resolved no single project, still emit a scope.
      const proxyMemberships = await prefetchMemberships(config, configOverride);
      const proxyScopeInputs = await buildScopeInputs(
        config,
        configOverride,
        projectId ?? undefined,
        args.all_projects === true,
        proxyMemberships,
      );
      const proxyResponse = proxyScopeInputs
        ? attachScope(proxyBaseWithDrafts, proxyScopeInputs)
        : proxyBaseWithDrafts;
      return emitRecallTelemetryAndReturn(proxyResponse, config.org_id);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      console.error(`[context] Proxy error: ${err instanceof Error ? err.stack || err.message : String(err)}`);
      // 019/US1 (R-001, contracts/mcp-context.md): on HTTP transport the
      // request is being served by a Vercel Function with live cloud access —
      // the `offline` flag is structurally impossible. Emit
      // `backend_unavailable` so operators (and the agent) get an
      // operator-actionable signal instead of the misleading "offline" cue
      // that drove uninstalls per BUG #84.
      // BUG #144: surface `error_message` so triage works without prod logs.
      return withMismatch({
        decisions: [], constraints: [], patterns: [], lessons: [],
        historical: [], total_in_brain: 0, suppressed_count: 0,
        backend_unavailable: true,
        error_message: errorMessage,
      });
    }
  }

  // 2026-05-21 (cross-project leak fix): explicit cross-project search now
  // requires `args.all_projects`. The previous behaviour silently fell back
  // to org-wide search whenever the server-mode caller didn't provide a
  // project scope, which leaked decisions across projects in the same org.
  // Callers that genuinely want cross-project results must opt in.
  const isServerMode = Boolean(configOverride);
  const wantsCrossProject = args.all_projects === true;

  if (!projectId && !wantsCrossProject && !args.target_project_id) {
    return withMismatch({
      decisions: [],
      constraints: [],
      patterns: [],
      lessons: [],
      historical: [],
      total_in_brain: 0,
      error: 'project_scope_required',
      note:
        'No project scope. Ask the user which project to load context for, ' +
        'then call valis_context again with `project_id`. To load context ' +
        'across every accessible project, pass `all_projects: true`.',
    });
  }
  // Silence isServerMode-only lint usage (still referenced below).
  void isServerMode;

  // 039/#94 / FR-011 — capture the membership list the cross-project branch
  // already fetches so the scope assembly below can reuse it instead of a
  // second lookup. `undefined` means "not fetched here" → scope resolution
  // falls back to its own gated lookup.
  let crossProjectAccessible: AccessibleProject[] | undefined;

  try {
    const qdrant = getQdrantClient(config.qdrant_url, config.qdrant_api_key);
    let results;

    if (wantsCrossProject) {
      // T022 + 019/US1: Cross-project context — load from all accessible projects
      let projectIds: string[] = [];
      try {
        const client = config.member_id
          ? selectMemberSupabaseClient(config, configOverride)
          : null;
        if (client && config.member_id) {
          const projects = await listMemberProjects(client.supabase, config.member_id);
          projectIds = projects.map((p) => p.id);
          // 039/#94 / FR-011 (finding #4): reuse this single fetch for the
          // scope assembly below instead of issuing a second RPC.
          crossProjectAccessible = projects.map((p) => ({ id: p.id, name: p.name }));
        }
      } catch {
        // Fall back to org-wide for CLI mode; HTTP-mode handled below.
      }

      if (projectIds.length > 0) {
        results = await hybridSearchAllProjects(qdrant, config.org_id, query, projectIds, { limit: 50 });
      } else if (isServerMode) {
        // 019/US1: HTTP transport + zero memberships → explicit indicator,
        // do NOT silently leak org-wide data the caller can't access.
        return withMismatch({
          decisions: [],
          constraints: [],
          patterns: [],
          lessons: [],
          historical: [],
          total_in_brain: 0,
          no_accessible_projects: true,
        });
      } else {
        results = await hybridSearch(qdrant, config.org_id, query, { limit: 50 });
      }
    } else {
      // T022: Default — context scoped to active project
      results = await hybridSearch(qdrant, config.org_id, query, { limit: 50, projectId });
    }

    // T047: Apply multi-signal reranking for consistent ordering with search
    const reranked: RerankedResult[] = rerank(results);

    // T050: Apply within-area suppression after reranking
    const { visible, suppressed_count } = suppressResults(reranked, 1.5, false);

    // Separate active/proposed from deprecated/superseded
    const active: RerankedResult[] = [];
    const historical: RerankedResult[] = [];

    for (const r of visible) {
      const status: DecisionStatus = r.status || 'active';
      if (HISTORICAL_STATUSES.has(status)) {
        historical.push(r);
      } else {
        active.push(r);
      }
    }

    // Group active results by type
    const grouped: Record<string, RerankedResult[]> = {
      decision: [],
      constraint: [],
      pattern: [],
      lesson: [],
    };

    for (const r of active) {
      const type = r.type === 'pending' ? 'decision' : r.type;
      if (grouped[type]) {
        grouped[type].push(r);
      }
    }

    // Limit each group to top results, with MMR diversity as the final
    // transform (037 / PR #228 review — see diversifyBucket).
    const decisions = diversifyBucket(grouped.decision);
    const constraints = diversifyBucket(grouped.constraint);
    const patterns = diversifyBucket(grouped.pattern);
    const lessons = diversifyBucket(grouped.lesson);

    const totalInBrain = reranked.length;
    let note: string | undefined;

    if (firstCall) {
      const historicalNote =
        historical.length > 0
          ? ` (${historical.length} historical/superseded items also available)`
          : '';
      const suppressedNote =
        suppressed_count > 0
          ? ` (${suppressed_count} similar results suppressed)`
          : '';
      note = `${totalInBrain} relevant decisions found in team brain${historicalNote}${suppressedNote}. Use valis_search for specific queries.`;
      firstCall = false;
    }

    const directBase = withMismatch({
      decisions,
      constraints,
      patterns,
      lessons,
      historical,
      total_in_brain: totalInBrain,
      suppressed_count,
      note,
    });
    // 039/#94 — scope envelope on the direct-Qdrant path via the shared helper
    // (finding #6). In single-project mode `projectId` (or the configured
    // scope) anchors the active project; in cross-project mode with no single
    // scope we still emit a scope with `active_project: null` (finding #2).
    // `crossProjectAccessible` reuses the membership list already fetched above
    // (FR-011, finding #4) so no second RPC is issued.
    const activeProjectId = projectId ?? config.project_id ?? undefined;
    // 040/#226 — draft-backlog block. Single-project scope only: pass the
    // RESOLVED `projectId` (not the config fallback) so it is omitted in
    // cross-project mode. Reuse the result scores for top_3.similarity.
    const directSimilarityById = new Map<string, number>();
    for (const r of reranked) {
      if (typeof r.score === 'number') directSimilarityById.set(r.id, r.score);
    }
    const directBaseWithDrafts = await attachProposedPending(directBase, {
      config,
      configOverride,
      args,
      projectId,
      isCrossOrgRead,
      similarityById: directSimilarityById,
    });
    const directScopeInputs = await buildScopeInputs(
      config,
      configOverride,
      activeProjectId,
      wantsCrossProject,
      crossProjectAccessible,
    );
    const directResponse = directScopeInputs
      ? attachScope(directBaseWithDrafts, directScopeInputs)
      : directBaseWithDrafts;
    return emitRecallTelemetryAndReturn(directResponse, config.org_id);
  } catch (err) {
    // 019/US1 (R-001, T068): server-mode (HTTP MCP transport) must NEVER emit
    // `offline:true` — that's a CLI-stdio fallback indicator. Emit
    // `infrastructure_error` (and `backend_unavailable` for contract symmetry)
    // so operators have an actionable signal. CLI-stdio path keeps `offline`
    // for legacy compatibility.
    //
    // BUG #144 (2026-05-03): the previous catch eaten the actual error via
    // `console.error` — agents calling MCP have no log access, so every
    // failure looked the same. Now propagate the message in `error_message`,
    // mirroring the pattern shipped for store.ts in BUG #143.
    const errorMessage = err instanceof Error ? err.message : String(err);
    if (isServerMode) {
      console.error(`[context] Backend error (server mode): ${errorMessage}`);
      return withMismatch({
        decisions: [],
        constraints: [],
        patterns: [],
        lessons: [],
        historical: [],
        total_in_brain: 0,
        suppressed_count: 0,
        infrastructure_error: true,
        backend_unavailable: true,
        error_message: errorMessage,
      });
    }
    return withMismatch({
      decisions: [],
      constraints: [],
      patterns: [],
      lessons: [],
      historical: [],
      total_in_brain: 0,
      suppressed_count: 0,
      offline: true,
    });
  }
}
