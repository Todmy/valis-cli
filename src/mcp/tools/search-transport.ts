/**
 * Search transport port — separates `handleSearch`'s orchestration
 * (rerank + suppress + cap + return-shape) from its data acquisition
 * (Qdrant direct vs hosted server-side proxy).
 *
 * Two adapters justify the port (production: proxy + direct). Each
 * adapter returns already-enriched + status-ranked SearchResults ready
 * for rerank/suppress, so handleSearch becomes branchless.
 */

import { getQdrantClient, hybridSearch, hybridSearchAllProjects } from '../../cloud/qdrant.js';
import { getSupabaseClient, getSupabaseJwtClient, listMemberProjects } from '../../cloud/supabase.js';
import { proxySearch } from '../../cloud/search-proxy.js';
import { isHostedMode } from '../../cloud/api-url.js';
import type {
  SearchResult,
  SearchExpand,
  ServerConfig,
  ValisConfig,
  DecisionStatus,
} from '../../types.js';

export interface SearchTransportOptions {
  type?: 'decision' | 'constraint' | 'pattern' | 'lesson';
  projectId?: string;
  all_projects?: boolean;
  expand?: SearchExpand;
}

export interface SearchTransport {
  /**
   * Returns SearchResults that the orchestrator can pass directly to
   * rerank + suppress. The proxy path's results are already enriched by
   * the server; the direct path enriches in-process. Either way, callers
   * see a uniform shape.
   *
   * Throws on cloud unreachability — orchestrator translates to the
   * `offline: true` envelope.
   */
  search(query: string, options: SearchTransportOptions): Promise<SearchResult[]>;
}

/** Status priority for ranking: lower = higher priority. */
const STATUS_PRIORITY: Record<DecisionStatus, number> = {
  active: 0,
  proposed: 1,
  deprecated: 2,
  superseded: 3,
};

const STATUS_LABELS: Record<DecisionStatus, string> = {
  active: 'active',
  proposed: 'proposed',
  deprecated: 'deprecated',
  superseded: 'superseded',
};

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

function buildReplacedByMap(
  results: Array<SearchResult & { replaces?: string | null }>,
): Map<string, string> {
  const map = new Map<string, string>();
  for (const r of results) {
    if (r.replaces) map.set(r.replaces, r.id);
  }
  return map;
}

/**
 * Per-row enrichment shared by both adapters: add status_label,
 * replaced_by reverse-lookup, and project_name when cross-project.
 */
function enrichRow(
  raw: SearchResult,
  replacedByMap: Map<string, string>,
  projectNameMap?: Map<string, string>,
): SearchResult {
  const status = raw.status || 'active';
  return {
    id: raw.id,
    score: raw.score,
    type: raw.type,
    summary: raw.summary,
    detail: raw.detail,
    author: raw.author,
    affects: raw.affects,
    created_at: raw.created_at,
    status,
    status_label: STATUS_LABELS[status] || status,
    replaced_by: replacedByMap.get(raw.id) ?? null,
    project_id: raw.project_id,
    project_name:
      raw.project_name ||
      (raw.project_id && projectNameMap ? projectNameMap.get(raw.project_id) : undefined),
  };
}

// ---------------------------------------------------------------------------
// Proxy transport (hosted mode — server-side enriches)
// ---------------------------------------------------------------------------

export function createProxyTransport(config: ValisConfig): SearchTransport {
  return {
    async search(query, options) {
      return proxySearch(config, query, {
        type: options.type,
        limit: 50,
        project_id: options.projectId,
        all_projects: options.all_projects,
        member_id: config.member_id ?? undefined,
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Direct transport (CLI / local — enriches in-process)
// ---------------------------------------------------------------------------

function pickSupabaseClient(config: ValisConfig, configOverride?: ServerConfig) {
  if (configOverride && config.supabase_service_role_key) {
    return getSupabaseClient(config.supabase_url, config.supabase_service_role_key);
  }
  if (config.auth_mode === 'jwt') {
    return getSupabaseJwtClient(
      config.supabase_url,
      config.member_api_key || config.api_key,
    );
  }
  return getSupabaseClient(config.supabase_url, config.supabase_service_role_key);
}

export function createDirectTransport(
  config: ValisConfig,
  configOverride?: ServerConfig,
): SearchTransport {
  return {
    async search(query, options) {
      const qdrant = getQdrantClient(config.qdrant_url, config.qdrant_api_key);
      let raw: SearchResult[];
      let projectNameMap: Map<string, string> | undefined;

      if (options.all_projects) {
        // Cross-project — fetch member's project list, search across them all.
        let projectIds: string[] = [];
        try {
          if (config.member_id) {
            const supabase = pickSupabaseClient(config, configOverride);
            const projects = await listMemberProjects(supabase, config.member_id);
            projectIds = projects.map((p) => p.id);
            projectNameMap = new Map<string, string>(projects.map((p) => [p.id, p.name]));
          }
        } catch {
          // Security: fail closed on project-list failures — fall through to
          // org-wide search rather than leaking results from inaccessible projects.
        }

        if (projectIds.length > 0) {
          raw = await hybridSearchAllProjects(qdrant, config.org_id, query, projectIds, {
            type: options.type,
            limit: 50,
            expand: options.expand,
          });
        } else {
          raw = await hybridSearch(qdrant, config.org_id, query, {
            type: options.type,
            limit: 50,
            expand: options.expand,
          });
        }
      } else {
        raw = await hybridSearch(qdrant, config.org_id, query, {
          type: options.type,
          limit: 50,
          projectId: options.projectId,
          expand: options.expand,
        });
      }

      const replacedByMap = buildReplacedByMap(
        raw as Array<SearchResult & { replaces?: string | null }>,
      );
      const enriched = raw.map((r) => enrichRow(r, replacedByMap, projectNameMap));
      return rankByStatus(enriched);
    },
  };
}

// ---------------------------------------------------------------------------
// Selector
// ---------------------------------------------------------------------------

export function chooseSearchTransport(
  config: ValisConfig,
  configOverride?: ServerConfig,
): SearchTransport {
  if (config.auth_mode === 'jwt' && isHostedMode(config)) {
    return createProxyTransport(config);
  }
  return createDirectTransport(config, configOverride);
}

/** Test seam — exposes status-rank for callers that already have enriched rows. */
export { rankByStatus };
