/**
 * JWT client module for CLI.
 * Manages token exchange, caching, and refresh for per-member auth.
 *
 * Design principles:
 * - Never let auth failures crash the CLI
 * - Use console.error for warnings (console.log is MCP stdout)
 * - Thread-safe cache: a single in-flight refresh promise is reused
 */

import type {
  AuthMode,
  ExchangeTokenResponse,
  TeamindConfig,
  TokenCache,
} from '../types.js';
import { getCount as getPendingCount } from '../offline/queue.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Refresh buffer: refresh the token when less than 5 minutes remain. */
const REFRESH_BUFFER_MS = 5 * 60 * 1000;

// ---------------------------------------------------------------------------
// Module-level singleton cache & mutex
// ---------------------------------------------------------------------------

let tokenCache: TokenCache | null = null;

/**
 * When a refresh is in flight, this promise is stored so concurrent callers
 * await the same operation instead of firing duplicate requests.
 */
let inflightRefresh: Promise<TokenCache | null> | null = null;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isExpiringSoon(expiresAt: string): boolean {
  const expiry = new Date(expiresAt).getTime();
  return Date.now() + REFRESH_BUFFER_MS >= expiry;
}

// ---------------------------------------------------------------------------
// Core functions
// ---------------------------------------------------------------------------

/**
 * Exchange an API key for a short-lived JWT via the `exchange-token` edge
 * function.
 *
 * On 401 (revoked / invalid key) this logs a warning and returns `null`
 * rather than throwing, allowing the CLI to fall back to offline mode.
 */
export async function exchangeToken(
  supabaseUrl: string,
  apiKey: string,
): Promise<ExchangeTokenResponse | null> {
  const url = `${supabaseUrl}/functions/v1/exchange-token`;

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: '{}',
    });
  } catch (err) {
    // Network failure — offline, DNS issue, etc.
    console.error(
      `[teamind] Token exchange failed (network): ${err instanceof Error ? err.message : String(err)}`,
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
      `[teamind] API key rejected (revoked or invalid). ` +
        `${pendingCount} decision(s) queued locally. ` +
        `Run \`teamind init\` to re-authenticate.`,
    );
    return null;
  }

  if (!res.ok) {
    let body = '';
    try {
      body = await res.text();
    } catch {
      // ignore
    }
    console.error(
      `[teamind] Token exchange failed (HTTP ${res.status}): ${body}`,
    );
    return null;
  }

  try {
    const data = (await res.json()) as ExchangeTokenResponse;
    return data;
  } catch (err) {
    console.error(
      `[teamind] Token exchange response parse error: ${err instanceof Error ? err.message : String(err)}`,
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
): Promise<TokenCache | null> {
  if (!isExpiringSoon(cache.jwt.expires_at)) {
    return cache;
  }

  // Token is expiring soon — exchange a fresh one
  const resp = await exchangeToken(supabaseUrl, apiKey);
  if (!resp) {
    // Exchange failed. If existing token has NOT yet expired (just inside
    // the buffer), keep using it. Otherwise clear.
    const expiry = new Date(cache.jwt.expires_at).getTime();
    if (Date.now() < expiry) {
      return cache;
    }
    return null;
  }

  const refreshed: TokenCache = {
    jwt: { token: resp.token, expires_at: resp.expires_at },
    member_id: resp.member_id,
    org_id: resp.org_id,
    role: resp.role,
    author_name: resp.author_name,
  };

  tokenCache = refreshed;
  return refreshed;
}

/**
 * Get a valid token, using the singleton cache and auto-refreshing when
 * close to expiry.
 *
 * Thread-safe: concurrent callers share a single in-flight refresh.
 *
 * Returns `null` when no token can be obtained (offline / revoked key).
 */
export async function getToken(
  supabaseUrl: string,
  apiKey: string,
): Promise<TokenCache | null> {
  // Fast path — cached and not expiring soon
  if (tokenCache && !isExpiringSoon(tokenCache.jwt.expires_at)) {
    return tokenCache;
  }

  // Avoid duplicate in-flight refresh requests (race-condition guard)
  if (inflightRefresh) {
    return inflightRefresh;
  }

  const doRefresh = async (): Promise<TokenCache | null> => {
    try {
      if (tokenCache) {
        return await refreshToken(supabaseUrl, apiKey, tokenCache);
      }

      // No cache yet — initial exchange
      const resp = await exchangeToken(supabaseUrl, apiKey);
      if (!resp) return null;

      const cache: TokenCache = {
        jwt: { token: resp.token, expires_at: resp.expires_at },
        member_id: resp.member_id,
        org_id: resp.org_id,
        role: resp.role,
        author_name: resp.author_name,
      };

      tokenCache = cache;
      return cache;
    } finally {
      inflightRefresh = null;
    }
  };

  inflightRefresh = doRefresh();
  return inflightRefresh;
}

// ---------------------------------------------------------------------------
// Utility functions
// ---------------------------------------------------------------------------

/**
 * Check whether the given config is operating in JWT auth mode.
 */
export function isJwtMode(config: TeamindConfig): boolean {
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
 */
export function getAccessTokenFn(
  supabaseUrl: string,
  apiKey: string,
): () => Promise<string> {
  return async (): Promise<string> => {
    const cache = await getToken(supabaseUrl, apiKey);
    return cache?.jwt.token ?? '';
  };
}

/**
 * Clear the module-level token cache. Intended for testing.
 */
export function clearTokenCache(): void {
  tokenCache = null;
  inflightRefresh = null;
}
