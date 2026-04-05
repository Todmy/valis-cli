import { loadConfig } from '../../config/store.js';
import { resolveConfig } from '../../config/project.js';
import { getQdrantClient, hybridSearch, hybridSearchAllProjects } from '../../cloud/qdrant.js';
import { getSupabaseClient, getSupabaseJwtClient, listMemberProjects } from '../../cloud/supabase.js';
import { proxySearch } from '../../cloud/search-proxy.js';
import { isHostedMode } from '../../cloud/api-url.js';
import { rerank } from '../../search/reranker.js';
import { suppressResults } from '../../search/suppression.js';
import { incrementUsage } from '../../billing/usage.js';
import type { SearchResponse, SearchResult, RerankedResult, DecisionStatus, ServerConfig, ValisConfig } from '../../types.js';

interface SearchArgs {
  query: string;
  type?: 'decision' | 'constraint' | 'pattern' | 'lesson';
  limit?: number;
  /** T021: When true, search across all projects the member has access to. */
  all_projects?: boolean;
}

/** Status priority for ranking: lower = higher priority. */
const STATUS_PRIORITY: Record<DecisionStatus, number> = {
  active: 0,
  proposed: 1,
  deprecated: 2,
  superseded: 3,
};

/** Human-readable status labels for search results (T013). */
const STATUS_LABELS: Record<DecisionStatus, string> = {
  active: 'active',
  proposed: 'proposed',
  deprecated: 'deprecated',
  superseded: 'superseded',
};

/**
 * Sort results so that active/proposed decisions rank above deprecated/superseded
 * when scores are equal (or very close). A tolerance of 0.01 treats scores within
 * that range as "equal relevance".
 */
function rankByStatus(results: SearchResult[]): SearchResult[] {
  const SCORE_TOLERANCE = 0.01;
  return [...results].sort((a, b) => {
    const scoreDiff = (b.score ?? 0) - (a.score ?? 0);
    if (Math.abs(scoreDiff) > SCORE_TOLERANCE) return scoreDiff;
    const statusA = STATUS_PRIORITY[a.status || 'active'] ?? 1;
    const statusB = STATUS_PRIORITY[b.status || 'active'] ?? 1;
    return statusA - statusB;
  });
}

/**
 * Build a reverse-lookup map: for each decision ID that has been replaced,
 * record the ID of the decision that replaced it.
 *
 * The raw results from Qdrant carry a `replaces` field (the ID of the older
 * decision). We invert that so each older decision gets a `replaced_by` value.
 */
function buildReplacedByMap(
  results: Array<SearchResult & { replaces?: string | null }>,
): Map<string, string> {
  const map = new Map<string, string>();
  for (const r of results) {
    if (r.replaces) {
      map.set(r.replaces, r.id);
    }
  }
  return map;
}

export async function handleSearch(args: SearchArgs, configOverride?: ServerConfig): Promise<SearchResponse> {
  const config = (configOverride ?? await loadConfig()) as ValisConfig | null;
  if (!config) {
    return { results: [], note: 'Not configured. Run `valis init` first.' };
  }

  // T021: Resolve project from per-directory config
  const resolved = configOverride ? null : await resolveConfig();
  const projectId = configOverride?.project_id || resolved?.project?.project_id;

  // Q8: Route through server-side proxy in hosted mode (no direct Qdrant access)
  if (config.auth_mode === 'jwt' && isHostedMode(config)) {
    try {
      const proxyResults = await proxySearch(config, args.query, {
        type: args.type,
        limit: 50,
        project_id: projectId ?? undefined,
        all_projects: args.all_projects,
        member_id: config.member_id ?? undefined,
      });

      // Apply reranking + suppression to proxy results
      const reranked: RerankedResult[] = rerank(proxyResults);
      const { visible, suppressed_count } = suppressResults(reranked, 1.5, false);
      const finalLimit = args.limit || 10;
      const finalResults = visible.slice(0, finalLimit);

      return { results: finalResults, suppressed_count };
    } catch {
      return {
        results: [],
        offline: true,
        note: 'Cloud unavailable. Search offline.',
      };
    }
  }

  try {
    const qdrant = getQdrantClient(config.qdrant_url, config.qdrant_api_key);
    let rawResults: SearchResult[];

    if (args.all_projects) {
      // T021: Cross-project search — get member's project list, search all accessible
      let projectIds: string[] = [];
    let projectListFailed = false;
      try {
        if (config.member_id) {
          const supabase = config.auth_mode === 'jwt'
            ? getSupabaseJwtClient(config.supabase_url, config.member_api_key || config.api_key)
            : getSupabaseClient(config.supabase_url, config.supabase_service_role_key);
          const projects = await listMemberProjects(supabase, config.member_id);
          projectIds = projects.map((p) => p.id);
        }
      } catch {
      // Security: fail closed
      projectListFailed = true;
        // If listing projects fails, fall back to org-wide search
      }

      if (projectIds.length > 0) {
        rawResults = await hybridSearchAllProjects(qdrant, config.org_id, args.query, projectIds, {
          type: args.type,
          limit: 50,
        });
      } else {
        // Fallback: search org-wide (no project filter)
        rawResults = await hybridSearch(qdrant, config.org_id, args.query, {
          type: args.type,
          limit: 50,
        });
      }
    } else {
      // T021: Default — search scoped to active project
      rawResults = await hybridSearch(qdrant, config.org_id, args.query, {
        type: args.type,
        limit: 50,
        projectId,
      });
    }

    // Build replaced_by reverse lookup from the `replaces` field in raw results
    const replacedByMap = buildReplacedByMap(
      rawResults as Array<SearchResult & { replaces?: string | null }>,
    );

    // T021: Build project_id -> project_name lookup for cross-project labeling
    let projectNameMap: Map<string, string> | undefined;
    if (args.all_projects) {
      projectNameMap = new Map<string, string>();
      try {
        if (config.member_id) {
          const supabase = config.auth_mode === 'jwt'
            ? getSupabaseJwtClient(config.supabase_url, config.member_api_key || config.api_key)
            : getSupabaseClient(config.supabase_url, config.supabase_service_role_key);
          const projects = await listMemberProjects(supabase, config.member_id);
          for (const p of projects) {
            projectNameMap.set(p.id, p.name);
          }
        }
      } catch {
        // Best-effort project name resolution
      }
    }

    // T013: Enrich each result with status and status_label.
    // Proposed decisions are included in default search results — not filtered
    // out. The status_label field provides a human-readable label for display.
    const enriched: SearchResult[] = rawResults.map((r) => {
      const status = r.status || 'active';
      return {
        id: r.id,
        score: r.score,
        type: r.type,
        summary: r.summary,
        detail: r.detail,
        author: r.author,
        affects: r.affects,
        created_at: r.created_at,
        status,
        status_label: STATUS_LABELS[status] || status,
        replaced_by: replacedByMap.get(r.id) ?? null,
        // T021: Include project info for cross-project results
        project_id: r.project_id,
        project_name: r.project_name || (r.project_id && projectNameMap ? projectNameMap.get(r.project_id) : undefined),
      };
    });

    // Rank active decisions above deprecated/superseded at equal relevance
    // Proposed decisions rank just below active but above deprecated/superseded
    const ranked = rankByStatus(enriched);

    // Apply multi-signal reranking for consistent ordering with CLI search
    const reranked: RerankedResult[] = rerank(ranked);

    // Apply within-area suppression after reranking
    const { visible, suppressed_count } = suppressResults(reranked, 1.5, false);

    // Respect requested limit after suppression
    const finalLimit = args.limit || 10;
    const finalResults = visible.slice(0, finalLimit);

    // Increment usage counter (best-effort — never block the search)
    try {
      const usageApiKey = config.auth_mode === 'jwt'
        ? (config.member_api_key || config.api_key)
        : config.supabase_service_role_key;
      await incrementUsage(
        config.supabase_url,
        usageApiKey,
        config.org_id,
        'search',
        config.auth_mode,
      );
    } catch {
      // Best-effort: usage increment failure must never block search operations
    }

    return { results: finalResults, suppressed_count };
  } catch {
    return {
      results: [],
      offline: true,
      note: 'Cloud unavailable. Search offline.',
    };
  }
}
