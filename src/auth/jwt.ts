/**
 * JWT client module for CLI.
 * Manages token exchange, caching, and refresh for per-member auth.
 *
 * Phase 4 extension: per-project token caching. Different JWTs are cached
 * per project_id (or "org" for org-level tokens without project_id).
 *
 * Design principles:
 * - Never let auth failures crash the CLI
 * - Use console.error for warnings (console.log is MCP stdout)
 * - Thread-safe cache: a single in-flight refresh promise is reused per key
 */

import type {
  AuthMode,
  ExchangeTokenResponse,
  ValisConfig,
  TokenCache,
} from '../types.js';
import { HOSTED_SUPABASE_URL } from '../types.js';
import { resolveApiUrl, resolveApiPath } from '../cloud/api-url.js';
import { getCount as getPendingCount } from '../offline/queue.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Refresh buffer: refresh the token when less than 5 minutes remain. */
const REFRESH_BUFFER_MS = 5 * 60 * 1000;

/** Cache key used for org-level JWTs (no project_id claim). */
const ORG_CACHE_KEY = '__org__';

// ---------------------------------------------------------------------------
// Module-level per-project cache & mutex
// ---------------------------------------------------------------------------

/**
 * Per-project token cache. Key is project_id or ORG_CACHE_KEY for
 * org-level tokens.
 */
const tokenCacheMap = new Map<string, TokenCache>();

/**
 * Per-key in-flight refresh promises. Concurrent callers for the same
 * cache key await the same operation.
 */
const inflightRefreshMap = new Map<string, Promise<TokenCache | null>>();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isExpiringSoon(expiresAt: string): boolean {
  const expiry = new Date(expiresAt).getTime();
  return Date.now() + REFRESH_BUFFER_MS >= expiry;
}

function cacheKey(projectId?: string): string {
  return projectId ?? ORG_CACHE_KEY;
}

function buildCacheEntry(resp: ExchangeTokenResponse, projectId?: string): TokenCache {
  return {
    jwt: { token: resp.token, expires_at: resp.expires_at },
    member_id: resp.member_id,
    org_id: resp.org_id,
    role: resp.role,
    author_name: resp.author_name,
    project_id: projectId ?? resp.project_id,
    project_role: resp.project_role,
  };
}

// ---------------------------------------------------------------------------
// Core functions
// ---------------------------------------------------------------------------

/**
 * Exchange an API key for a short-lived JWT via the `exchange-token` edge
 * function.
 *
 * When `projectId` is provided, the resulting JWT will include `project_id`
 * and `project_role` claims for project-scoped RLS.
 *
 * On 401 (revoked / invalid key) this logs a warning and returns `null`
 * rather than throwing, allowing the CLI to fall back to offline mode.
 */
export async function exchangeToken(
  supabaseUrl: string,
  apiKey: string,
  projectId?: string,
): Promise<ExchangeTokenResponse | null> {
  const isHosted = supabaseUrl.replace(/\/$/, '') === HOSTED_SUPABASE_URL;
  const apiBase = resolveApiUrl(supabaseUrl, isHosted);
  const url = resolveApiPath(apiBase, 'exchange-token');

  const body: Record<string, unknown> = {};
  if (projectId) {
    body.project_id = projectId;
  }

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    // Network failure — offline, DNS issue, etc.
    console.error(
      `[valis] Token exchange failed (network): ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }

  if (res.status === 401) {
    let pendingCount = 0;
    try {
      pendingCount = await getPendingCount();
    } catch {
      // Ignore — best-effort count
    }
    console.error(
      `[valis] API key rejected (revoked or invalid). ` +
        `${pendingCount} decision(s) queued locally. ` +
        `Run \`valis init\` to re-authenticate.`,
    );
    return null;
  }

  if (res.status === 403) {
    let responseBody = '';
    try {
      responseBody = await res.text();
    } catch {
      // ignore
    }
    console.error(
      `[valis] Project access denied: ${responseBody}`,
    );
    return null;
  }

  if (!res.ok) {
    let responseBody = '';
    try {
      responseBody = await res.text();
    } catch {
      // ignore
    }
    console.error(
      `[valis] Token exchange failed (HTTP ${res.status}): ${responseBody}`,
    );
    return null;
  }

  try {
    const data = (await res.json()) as ExchangeTokenResponse;
    return data;
  } catch (err) {
    console.error(
      `[valis] Token exchange response parse error: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

/**
 * Refresh the cached token if it is expiring within the 5-minute buffer.
 *
 * Returns the (possibly refreshed) cache, or `null` if the refresh failed
 * and no valid cache exists.
 */
export async function refreshToken(
  supabaseUrl: string,
  apiKey: string,
  cache: TokenCache,
  projectId?: string,
): Promise<TokenCache | null> {
  if (!isExpiringSoon(cache.jwt.expires_at)) {
    return cache;
  }

  // Token is expiring soon — exchange a fresh one
  const resp = await exchangeToken(supabaseUrl, apiKey, projectId);
  if (!resp) {
    // Exchange failed. If existing token has NOT yet expired (just inside
    // the buffer), keep using it. Otherwise clear.
    const expiry = new Date(cache.jwt.expires_at).getTime();
    if (Date.now() < expiry) {
      return cache;
    }
    return null;
  }

  const refreshed = buildCacheEntry(resp, projectId);
  tokenCacheMap.set(cacheKey(projectId), refreshed);
  return refreshed;
}

/**
 * Get a valid project-scoped token, using the per-project cache and
 * auto-refreshing when close to expiry.
 *
 * Thread-safe: concurrent callers for the same project share a single
 * in-flight refresh.
 *
 * When `projectId` is omitted, returns an org-level JWT without
 * project_id claim (for cross-project search).
 *
 * Returns `null` when no token can be obtained (offline / revoked key).
 */
export async function getToken(
  supabaseUrl: string,
  apiKey: string,
  projectId?: string,
): Promise<TokenCache | null> {
  const key = cacheKey(projectId);
  const cached = tokenCacheMap.get(key);

  // Fast path — cached and not expiring soon
  if (cached && !isExpiringSoon(cached.jwt.expires_at)) {
    return cached;
  }

  // Avoid duplicate in-flight refresh requests (race-condition guard)
  const existing = inflightRefreshMap.get(key);
  if (existing) {
    return existing;
  }

  const doRefresh = async (): Promise<TokenCache | null> => {
    try {
      if (cached) {
        return await refreshToken(supabaseUrl, apiKey, cached, projectId);
      }

      // No cache yet — initial exchange
      const resp = await exchangeToken(supabaseUrl, apiKey, projectId);
      if (!resp) return null;

      const entry = buildCacheEntry(resp, projectId);
      tokenCacheMap.set(key, entry);
      return entry;
    } finally {
      inflightRefreshMap.delete(key);
    }
  };

  const promise = doRefresh();
  inflightRefreshMap.set(key, promise);
  return promise;
}

/**
 * Get an org-level JWT without project_id claim.
 *
 * Used for cross-project search where the caller needs org-wide access
 * with application-level filtering by accessible projects.
 */
export async function getOrgToken(
  supabaseUrl: string,
  apiKey: string,
): Promise<TokenCache | null> {
  return getToken(supabaseUrl, apiKey, undefined);
}

// ---------------------------------------------------------------------------
// Utility functions
// ---------------------------------------------------------------------------

/**
 * Check whether the given config is operating in JWT auth mode.
 */
export function isJwtMode(config: ValisConfig): boolean {
  return config.auth_mode === 'jwt';
}

/**
 * Returns a closure suitable for `createClient({ accessToken })`.
 *
 * The closure calls `getToken` on each invocation, which returns a cached
 * value in the fast path and refreshes transparently when needed.
 *
 * If the token cannot be obtained the closure returns an empty string,
 * which will cause Supabase requests to fail with 401 — the caller should
 * handle this gracefully (e.g., fall back to offline mode).
 *
 * When `projectId` is provided, the returned tokens will include
 * project_id and project_role claims.
 */
export function getAccessTokenFn(
  supabaseUrl: string,
  apiKey: string,
  projectId?: string,
): () => Promise<string> {
  return async (): Promise<string> => {
    const cache = await getToken(supabaseUrl, apiKey, projectId);
    return cache?.jwt.token ?? '';
  };
}

/**
 * Clear the module-level token cache. Intended for testing.
 */
export function clearTokenCache(): void {
  tokenCacheMap.clear();
  inflightRefreshMap.clear();
}
