import { loadConfig } from '../../config/store.js';
import { resolveConfig } from '../../config/project.js';
import { getQdrantClient, hybridSearch, hybridSearchAllProjects } from '../../cloud/qdrant.js';
import { getSupabaseClient, getSupabaseJwtClient, listMemberProjects } from '../../cloud/supabase.js';
import { proxySearch } from '../../cloud/search-proxy.js';
import { isHostedMode } from '../../cloud/api-url.js';
import { rerank } from '../../search/reranker.js';
import { suppressResults } from '../../search/suppression.js';
import type { ContextResponse, RerankedResult, DecisionStatus, ServerConfig, ValisConfig } from '../../types.js';

interface ContextArgs {
  task_description: string;
  files?: string[];
  /** T022: When true, load context from all accessible projects. */
  all_projects?: boolean;
}

/** Statuses considered non-active (historical). */
const HISTORICAL_STATUSES: Set<DecisionStatus> = new Set(['deprecated', 'superseded']);

let firstCall = true;

export async function handleContext(args: ContextArgs, configOverride?: ServerConfig): Promise<ContextResponse> {
  const config = (configOverride ?? await loadConfig()) as ValisConfig | null;
  if (!config) {
    return {
      decisions: [],
      constraints: [],
      patterns: [],
      lessons: [],
      historical: [],
      total_in_brain: 0,
      note: 'Not configured. Run `valis init` first.',
    };
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

  // T022: Resolve project from per-directory config
  const resolved = configOverride ? null : await resolveConfig();
  const projectId = configOverride?.project_id || resolved?.project?.project_id;

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

      return {
        decisions: grouped.decision.slice(0, 20),
        constraints: grouped.constraint.slice(0, 20),
        patterns: grouped.pattern.slice(0, 20),
        lessons: grouped.lesson.slice(0, 20),
        historical,
        total_in_brain: totalInBrain,
        suppressed_count,
        note,
      };
    } catch (err) {
      console.error(`[context] Proxy error: ${err instanceof Error ? err.stack || err.message : String(err)}`);
      // 019/US1 (R-001, contracts/mcp-context.md): on HTTP transport the
      // request is being served by a Vercel Function with live cloud access —
      // the `offline` flag is structurally impossible. Emit
      // `backend_unavailable` so operators (and the agent) get an
      // operator-actionable signal instead of the misleading "offline" cue
      // that drove uninstalls per BUG #84.
      return {
        decisions: [], constraints: [], patterns: [], lessons: [],
        historical: [], total_in_brain: 0, suppressed_count: 0,
        backend_unavailable: true,
      };
    }
  }

  // 019/US1 (R-001 + R-006 + contracts/mcp-context.md):
  //   When running server-side (configOverride set = HTTP MCP transport) and
  //   no project scope is set, mirror handleSearch's cross-project fallback:
  //   pull the caller's project memberships and search across them. If the
  //   caller has zero accessible projects, surface
  //   `no_accessible_projects: true` so the agent can distinguish "no data
  //   yet" from "infrastructure failure".
  const isServerMode = Boolean(configOverride);
  const wantsCrossProject = args.all_projects || (isServerMode && !projectId);

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
        return {
          decisions: [],
          constraints: [],
          patterns: [],
          lessons: [],
          historical: [],
          total_in_brain: 0,
          no_accessible_projects: true,
        };
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

    return {
      decisions,
      constraints,
      patterns,
      lessons,
      historical,
      total_in_brain: totalInBrain,
      suppressed_count,
      note,
    };
  } catch (err) {
    // 019/US1 (R-001, T068): server-mode (HTTP MCP transport) must NEVER emit
    // `offline:true` — that's a CLI-stdio fallback indicator. Emit
    // `infrastructure_error` (and `backend_unavailable` for contract symmetry)
    // so operators have an actionable signal. CLI-stdio path keeps `offline`
    // for legacy compatibility.
    if (isServerMode) {
      console.error(
        `[context] Backend error (server mode): ${err instanceof Error ? err.message : String(err)}`,
      );
      return {
        decisions: [],
        constraints: [],
        patterns: [],
        lessons: [],
        historical: [],
        total_in_brain: 0,
        suppressed_count: 0,
        infrastructure_error: true,
        backend_unavailable: true,
      };
    }
    return {
      decisions: [],
      constraints: [],
      patterns: [],
      lessons: [],
      historical: [],
      total_in_brain: 0,
      suppressed_count: 0,
      offline: true,
    };
  }
}
