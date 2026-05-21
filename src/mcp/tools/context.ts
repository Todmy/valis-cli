import { loadConfig } from '../../config/store.js';
import { resolveConfig } from '../../config/project.js';
import { getQdrantClient, hybridSearch, hybridSearchAllProjects } from '../../cloud/qdrant.js';
import { getSupabaseClient, getSupabaseJwtClient, listMemberProjects } from '../../cloud/supabase.js';
import { proxySearch } from '../../cloud/search-proxy.js';
import { isHostedMode } from '../../cloud/api-url.js';
import { rerank } from '../../search/reranker.js';
import { suppressResults } from '../../search/suppression.js';
import { canReadProject } from '../../lib/project-access.js';
import { storeAuditEntry } from '../../cloud/supabase/audit.js';
import type { ContextResponse, RerankedResult, DecisionStatus, ServerConfig, ValisConfig } from '../../types.js';

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

  // Feature 033 — public-KB cross-org gate. Mirrors handleSearch.
  if (args.target_project_id && args.target_project_id !== projectId) {
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
      const proxyResults = await proxySearch(config, query, {
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

      return withMismatch({
        decisions: grouped.decision.slice(0, 20),
        constraints: grouped.constraint.slice(0, 20),
        patterns: grouped.pattern.slice(0, 20),
        lessons: grouped.lesson.slice(0, 20),
        historical,
        total_in_brain: totalInBrain,
        suppressed_count,
        note,
      });
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

  try {
    const qdrant = getQdrantClient(config.qdrant_url, config.qdrant_api_key);
    let results;

    if (wantsCrossProject) {
      // T022 + 019/US1: Cross-project context — load from all accessible projects
      let projectIds: string[] = [];
      try {
        if (config.member_id) {
          const supabase = (configOverride && config.supabase_service_role_key)
            ? getSupabaseClient(config.supabase_url, config.supabase_service_role_key)
            : config.auth_mode === 'jwt'
              ? getSupabaseJwtClient(config.supabase_url, config.member_api_key || config.api_key)
              : getSupabaseClient(config.supabase_url, config.supabase_service_role_key);
          const projects = await listMemberProjects(supabase, config.member_id);
          projectIds = projects.map((p) => p.id);
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

    // Limit each group to top results (already sorted by composite_score)
    const decisions = grouped.decision.slice(0, 20);
    const constraints = grouped.constraint.slice(0, 20);
    const patterns = grouped.pattern.slice(0, 20);
    const lessons = grouped.lesson.slice(0, 20);

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

    return withMismatch({
      decisions,
      constraints,
      patterns,
      lessons,
      historical,
      total_in_brain: totalInBrain,
      suppressed_count,
      note,
    });
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
