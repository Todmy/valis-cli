import type {
  ExchangeTokenResponse,
  TeamindConfig,
  TokenCache,
} from '../types.js';
import { getCount as getPendingQueueCount } from '../offline/queue.js';

// ---------------------------------------------------------------------------
// Module-level cache
// ---------------------------------------------------------------------------

let tokenCache: TokenCache | null = null;

/** Visible for testing. */
export function _resetCache(): void {
  tokenCache = null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const REFRESH_MARGIN_MS = 5 * 60 * 1000; // 5 minutes

function isExpiringSoon(expiresAt: string): boolean {
  const expiryMs = new Date(expiresAt).getTime();
  return expiryMs - Date.now() <= REFRESH_MARGIN_MS;
}

// ---------------------------------------------------------------------------
// exchangeToken
// ---------------------------------------------------------------------------

/**
 * POST to the `exchange-token` Edge Function, exchanging an API key for a
 * short-lived JWT.
 *
 * On 401 (key revoked): logs a warning with the pending queue count, does
 * **not** throw — the caller should skip the flush and continue gracefully.
 * On any other HTTP error: throws.
 */
export async function exchangeToken(
  supabaseUrl: string,
  apiKey: string,
): Promise<ExchangeTokenResponse> {
  const url = `${supabaseUrl}/functions/v1/exchange-token`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: '{}',
  });

  if (res.status === 401) {
    const pending = await getPendingQueueCount();
    console.warn(
      `[teamind] API key rejected (revoked or invalid). ${pending} decision(s) in pending queue — skipping flush.`,
    );
    // Return a sentinel that callers can detect — we throw a typed error
    // so callers can distinguish revoked-key from other failures.
    const err = new Error('API key revoked or invalid') as Error & { code: string };
    err.code = 'KEY_REVOKED';
    throw err;
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(
      `exchange-token failed (${res.status}): ${body}`,
    );
  }

  return (await res.json()) as ExchangeTokenResponse;
}

// ---------------------------------------------------------------------------
// refreshToken
// ---------------------------------------------------------------------------

/**
 * If the cached token expires within 5 minutes, exchange a new one.
 * Otherwise return the existing cache as-is.
 */
export async function refreshToken(
  supabaseUrl: string,
  apiKey: string,
  cache: TokenCache,
): Promise<TokenCache> {
  if (!isExpiringSoon(cache.jwt.expires_at)) {
    return cache;
  }

  const resp = await exchangeToken(supabaseUrl, apiKey);
  return {
    jwt: { token: resp.token, expires_at: resp.expires_at },
    member_id: resp.member_id,
    org_id: resp.org_id,
    role: resp.role,
    author_name: resp.author_name,
  };
}

// ---------------------------------------------------------------------------
// getToken
// ---------------------------------------------------------------------------

/**
 * Return a cached JWT or exchange a new one. Manages the module-level cache.
 */
export async function getToken(
  supabaseUrl: string,
  apiKey: string,
): Promise<string> {
  if (tokenCache && !isExpiringSoon(tokenCache.jwt.expires_at)) {
    return tokenCache.jwt.token;
  }

  const resp = await exchangeToken(supabaseUrl, apiKey);
  tokenCache = {
    jwt: { token: resp.token, expires_at: resp.expires_at },
    member_id: resp.member_id,
    org_id: resp.org_id,
    role: resp.role,
    author_name: resp.author_name,
  };
  return tokenCache.jwt.token;
}

// ---------------------------------------------------------------------------
// isJwtMode
// ---------------------------------------------------------------------------

/**
 * Return `true` if the config indicates JWT auth mode.
 */
export function isJwtMode(config: TeamindConfig): boolean {
  return config.auth_mode === 'jwt';
}

// ---------------------------------------------------------------------------
// getAccessTokenFn
// ---------------------------------------------------------------------------

/**
 * Returns a function suitable for the Supabase `createClient({ accessToken })`
 * option. Each invocation returns a valid (possibly refreshed) JWT string.
 */
export function getAccessTokenFn(
  supabaseUrl: string,
  apiKey: string,
): () => Promise<string> {
  return () => getToken(supabaseUrl, apiKey);
}
