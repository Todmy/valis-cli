/**
 * Supabase client + connection lifecycle.
 *
 * Owns: two singleton clients (service-role + JWT-mode), reset hooks for
 * testing, a tiny `set_config('app.org_id')` helper that the decision /
 * dashboard / audit modules call before queries, and a liveness probe.
 *
 * Nothing about decisions, members, or audit lives here — those concerns
 * sit in sibling modules.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { getAccessTokenFn } from '../../auth/jwt.js';

let client: SupabaseClient | null = null;

export function getSupabaseClient(url: string, serviceRoleKey: string): SupabaseClient {
  if (!client) {
    client = createClient(url, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return client;
}

export function resetClient(): void {
  client = null;
}

// ---------------------------------------------------------------------------
// JWT-authenticated client (Phase 2)
// ---------------------------------------------------------------------------

let jwtClient: SupabaseClient | null = null;

/**
 * Create a Supabase client that authenticates via JWT tokens obtained from
 * the exchange-token Edge Function.
 *
 * Uses the `accessToken` callback pattern described in research.md —
 * each request gets a fresh (or cached) JWT transparently.
 *
 * Keep separate from `getSupabaseClient` to avoid breaking legacy
 * service_role callers.
 */
export function getSupabaseJwtClient(
  url: string,
  apiKey: string,
): SupabaseClient {
  if (!jwtClient) {
    // The anonKey parameter is unused when accessToken callback is set —
    // every request gets its auth from the JWT returned by exchange-token.
    // Pass the URL as a placeholder anonKey to satisfy the createClient signature.
    jwtClient = createClient(url, url, {
      accessToken: getAccessTokenFn(url, apiKey),
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return jwtClient;
}

export function resetJwtClient(): void {
  jwtClient = null;
}

/**
 * Set the `app.org_id` Postgres session variable for the current connection.
 *
 * Used by RLS policies that prefer reading the session var over hashing org_id
 * out of JWT claims. Silently no-ops when the `set_config` RPC isn't installed
 * — RLS still works via explicit `WHERE org_id = ...` filters in callers.
 *
 * Exported for use within the supabase sub-module family (decisions.ts,
 * dashboard.ts). Treat as internal API: external callers should NOT depend
 * on this directly.
 */
export async function setOrgContext(supabase: SupabaseClient, orgId: string): Promise<void> {
  try {
    await supabase.rpc('set_config', {
      setting: 'app.org_id',
      value: orgId,
    });
  } catch {
    // set_config may not exist yet — RLS still works via explicit org_id filter
  }
}

export async function healthCheck(supabase: SupabaseClient): Promise<boolean> {
  try {
    const { error } = await supabase.from('orgs').select('id').limit(1);
    return !error;
  } catch {
    return false;
  }
}
