/**
 * Q8: Search proxy for hosted mode.
 *
 * Routes search requests through the Vercel API (/api/search) instead of
 * connecting to Qdrant directly. Hosted users don't have qdrant_api_key,
 * so all search traffic goes through the server-side proxy.
 */

import type { SearchResult, ValisConfig } from '../types.js';
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
 * Perform a search via the hosted API proxy.
 *
 * Gets a JWT via token exchange, then POSTs to /api/search on the
 * Vercel deployment. Returns parsed SearchResult[] or empty array on failure.
 */
export async function proxySearch(
  config: ValisConfig,
  query: string,
  options: ProxySearchOptions = {},
): Promise<SearchResult[]> {
  // Get JWT for authentication
  const apiKey = config.member_api_key || config.api_key;
  const tokenCache = await getToken(
    config.supabase_url,
    apiKey,
    config.project_id ?? undefined,
  );

  if (!tokenCache) {
    console.error('[valis] Search proxy: could not obtain JWT');
    return [];
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
    return [];
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
    return [];
  }

  try {
    const data = (await res.json()) as { results: SearchResult[]; count: number };
    return data.results ?? [];
  } catch (err) {
    console.error(
      `[valis] Search proxy response parse error: ${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }
}
