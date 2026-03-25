/**
 * URL resolution helpers for Vercel API migration (006).
 *
 * In hosted mode, CLI calls route through the Vercel deployment at
 * HOSTED_API_URL (`/api/<name>`). In community / self-hosted mode,
 * calls continue to use Supabase Edge Functions (`/functions/v1/<name>`).
 *
 * @module cloud/api-url
 */

import {
  HOSTED_API_URL,
  HOSTED_SUPABASE_URL,
  type TeamindConfig,
} from '../types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the base API URL for Edge Function / API route calls.
 *
 * - **Hosted mode** (`isHosted === true`): returns {@link HOSTED_API_URL}
 * - **Community mode**: returns the given `supabaseUrl` unchanged
 */
export function resolveApiUrl(supabaseUrl: string, isHosted: boolean): string {
  return isHosted ? HOSTED_API_URL : supabaseUrl.replace(/\/$/, '');
}

/**
 * Build the full path for an API function call.
 *
 * - When `apiUrl` equals {@link HOSTED_API_URL} the path is `/api/<name>`
 *   (Vercel API route).
 * - Otherwise the path is `/functions/v1/<name>` (Supabase Edge Function).
 */
export function resolveApiPath(apiUrl: string, functionName: string): string {
  const base = apiUrl.replace(/\/$/, '');
  if (base === HOSTED_API_URL) {
    return `${base}/api/${functionName}`;
  }
  return `${base}/functions/v1/${functionName}`;
}

/**
 * Detect whether the given config represents a hosted-mode installation.
 *
 * Hosted mode is true when:
 * 1. `supabase_url` matches {@link HOSTED_SUPABASE_URL}, AND
 * 2. No `supabase_service_role_key` is present (hosted users never have one)
 */
export function isHostedMode(config: TeamindConfig): boolean {
  return (
    config.supabase_url === HOSTED_SUPABASE_URL &&
    (!config.supabase_service_role_key || config.supabase_service_role_key === '')
  );
}

export { HOSTED_API_URL };
