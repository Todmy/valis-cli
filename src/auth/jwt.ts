import type {
  ExchangeTokenResponse,
  TokenCache,
  TeamindConfig,
} from '../types.js';

// ---------------------------------------------------------------------------
// Module-level singleton cache + in-flight refresh guard
// ---------------------------------------------------------------------------

let cache: TokenCache | null = null;
let refreshPromise: Promise<ExchangeTokenResponse | null> | null = null;

/** 5-minute buffer before expiry triggers a refresh. */
const REFRESH_BUFFER_MS = 5 * 60 * 1000;

// ---------------------------------------------------------------------------
// exchangeToken — call edge function, return response or null
// ---------------------------------------------------------------------------

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
    // Network error — offline mode
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[teamind] Token exchange network error: ${msg}`);
    return null;
  }

  if (res.status === 401) {
    console.error('[teamind] API key revoked or invalid (401)');
    return null;
  }

  if (!res.ok) {
    console.error(`[teamind] Token exchange failed: HTTP ${res.status}`);
    return null;
  }

  const data = (await res.json()) as ExchangeTokenResponse;
  return data;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function isExpiringSoon(expiresAt: string): boolean {
  const expiryMs = new Date(expiresAt).getTime();
  return Date.now() + REFRESH_BUFFER_MS >= expiryMs;
}

async function refresh(
  supabaseUrl: string,
  apiKey: string,
): Promise<ExchangeTokenResponse | null> {
  const resp = await exchangeToken(supabaseUrl, apiKey);
  if (resp) {
    cache = {
      jwt: { token: resp.token, expires_at: resp.expires_at },
      member_id: resp.member_id,
      org_id: resp.org_id,
      role: resp.role,
      author_name: resp.author_name,
    };
  }
  return resp;
}

// ---------------------------------------------------------------------------
// getToken — cached JWT string, auto-refreshes
// ---------------------------------------------------------------------------

export async function getToken(
  supabaseUrl: string,
  apiKey: string,
): Promise<string> {
  // Fast path: cache is valid and not expiring soon
  if (cache && !isExpiringSoon(cache.jwt.expires_at)) {
    return cache.jwt.token;
  }

  // Race condition protection: if a refresh is already in-flight, await it
  if (refreshPromise) {
    const result = await refreshPromise;
    if (result) return result.token;
    // Refresh failed but we still have an unexpired (though soon-to-expire) token
    if (cache) return cache.jwt.token;
    throw new Error('Token refresh failed and no cached token available');
  }

  // Start a new refresh
  refreshPromise = refresh(supabaseUrl, apiKey).finally(() => {
    refreshPromise = null;
  });

  const result = await refreshPromise;
  if (result) return result.token;

  // Refresh failed — fall back to existing cache if still technically valid
  if (cache) {
    const expiryMs = new Date(cache.jwt.expires_at).getTime();
    if (Date.now() < expiryMs) {
      return cache.jwt.token;
    }
  }

  throw new Error('Token exchange failed and no cached token available');
}

// ---------------------------------------------------------------------------
// isJwtMode — check config auth mode
// ---------------------------------------------------------------------------

export function isJwtMode(config: TeamindConfig): boolean {
  return config.auth_mode === 'jwt';
}

// ---------------------------------------------------------------------------
// getAccessTokenFn — closure for createClient({ accessToken })
// ---------------------------------------------------------------------------

export function getAccessTokenFn(
  supabaseUrl: string,
  apiKey: string,
): () => Promise<string> {
  return () => getToken(supabaseUrl, apiKey);
}

// ---------------------------------------------------------------------------
// refreshToken — refresh if expiring soon, otherwise return cache as-is
// ---------------------------------------------------------------------------

export async function refreshToken(
  supabaseUrl: string,
  apiKey: string,
  existing: TokenCache,
): Promise<TokenCache> {
  if (!isExpiringSoon(existing.jwt.expires_at)) {
    return existing;
  }

  const resp = await exchangeToken(supabaseUrl, apiKey);
  if (!resp) {
    // Exchange failed (revoked key / network) — keep existing cache
    return existing;
  }

  return {
    jwt: { token: resp.token, expires_at: resp.expires_at },
    member_id: resp.member_id,
    org_id: resp.org_id,
    role: resp.role,
    author_name: resp.author_name,
  };
}

// ---------------------------------------------------------------------------
// clearTokenCache — for testing
// ---------------------------------------------------------------------------

export function clearTokenCache(): void {
  cache = null;
  refreshPromise = null;
}
