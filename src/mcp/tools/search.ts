import { loadConfig } from '../../config/store.js';
import { resolveConfig } from '../../config/project.js';
import { rerank } from '../../search/reranker.js';
import { suppressResults } from '../../search/suppression.js';
import { incrementUsage } from '../../billing/usage.js';
import { isHostedMode } from '../../cloud/api-url.js';
import { chooseSearchTransport, type SearchTransport } from './search-transport.js';
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
  const transport: SearchTransport = chooseSearchTransport(config, configOverride);

  let enriched;
  try {
    enriched = await transport.search(args.query, {
      type: args.type,
      projectId,
      all_projects: args.all_projects,
      expand: args.expand,
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
  const finalResults = visible.slice(0, args.limit ?? DEFAULT_LIMIT);

  // Hosted-proxy mode: server-side /api/search already increments usage.
  // Direct mode: client-side billing.
  if (!isHostedProxy) {
    await tryIncrementUsage(config, configOverride);
  }

  return { results: finalResults, suppressed_count };
}
