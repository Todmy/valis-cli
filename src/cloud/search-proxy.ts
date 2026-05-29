/**
 * Q8: Search proxy for hosted mode.
 *
 * Routes search requests through the Vercel API (/api/search) instead of
 * connecting to Qdrant directly. Hosted users don't have qdrant_api_key,
 * so all search traffic goes through the server-side proxy.
 */

import type { ProposedPending, SearchResult, ValisConfig } from '../types.js';
import { resolveApiUrl, isHostedMode } from '../cloud/api-url.js';
import { getToken } from '../auth/jwt.js';

export interface ProxySearchOptions {
  type?: string;
  limit?: number;
  project_id?: string;
  all_projects?: boolean;
  member_id?: string;
}

/**
 * 040/#226 (finding #2) — the proxy return now threads the server-computed
 * `proposed_pending` block back to the orchestrator. `/api/search` already
 * runs the truncation-proof COUNT server-side (service-role, explicit
 * org_id+project_id filter); discarding it here forced `handleSearch` to
 * recompute the same 6 round-trips client-side. Threading it through lets the
 * orchestrator reuse the server value verbatim. `undefined` when the server
 * omitted it (cross-project / no scope / COUNT failure — FR-006).
 */
export interface ProxySearchResult {
  results: SearchResult[];
  proposed_pending?: ProposedPending;
}

/**
 * Perform a search via the hosted API proxy.
 *
 * Gets a JWT via token exchange, then POSTs to /api/search on the
 * Vercel deployment. Returns parsed results + the server-computed
 * `proposed_pending` block, or `{ results: [] }` on failure.
 */
export async function proxySearch(
  config: ValisConfig,
  query: string,
  options: ProxySearchOptions = {},
): Promise<ProxySearchResult> {
  // Get JWT for authentication
  const apiKey = config.member_api_key || config.api_key;
  const tokenCache = await getToken(
    config.supabase_url,
    apiKey,
    config.project_id ?? undefined,
  );

  if (!tokenCache) {
    console.error('[valis] Search proxy: could not obtain JWT');
    return { results: [] };
  }

  const isHosted = isHostedMode(config);
  const apiBase = resolveApiUrl(config.supabase_url, isHosted);
  const url = `${apiBase}/api/search`;

  const body: Record<string, unknown> = { query };
  if (options.type) body.type = options.type;
  if (options.limit) body.limit = options.limit;
  if (options.project_id) body.project_id = options.project_id;
  if (options.all_projects) body.all_projects = true;
  if (options.member_id) body.member_id = options.member_id;

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tokenCache.jwt.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    console.error(
      `[valis] Search proxy request failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { results: [] };
  }

  if (!res.ok) {
    let errorText = '';
    try {
      errorText = await res.text();
    } catch {
      // ignore
    }
    console.error(
      `[valis] Search proxy HTTP ${res.status}: ${errorText}`,
    );
    return { results: [] };
  }

  try {
    const data = (await res.json()) as {
      results: SearchResult[];
      count: number;
      proposed_pending?: ProposedPending;
    };
    // finding #2 — surface the server-computed block. `/api/search` omits the
    // key entirely (not null) when out of scope, so `?? undefined` keeps the
    // OMIT semantics intact (FR-006).
    return { results: data.results ?? [], proposed_pending: data.proposed_pending };
  } catch (err) {
    console.error(
      `[valis] Search proxy response parse error: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { results: [] };
  }
}
