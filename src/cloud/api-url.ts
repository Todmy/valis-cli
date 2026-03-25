/**
 * T008: URL resolution helpers for hosted vs community mode.
 *
 * Hosted mode routes API calls through the Vercel deployment at
 * HOSTED_API_URL (/api/<name>). Community mode keeps using the
 * Supabase Edge Functions URL (/functions/v1/<name>).
 */

import {
  HOSTED_API_URL,
  HOSTED_SUPABASE_URL,
  type TeamindConfig,
} from '../types.js';

/**
 * Return the base API URL for the given Supabase URL.
 * - Hosted mode (supabaseUrl matches HOSTED_SUPABASE_URL): returns HOSTED_API_URL.
 * - Community mode: returns the supabaseUrl as-is (EFs are co-located).
 */
export function resolveApiUrl(supabaseUrl: string, isHosted: boolean): string {
  if (isHosted) return HOSTED_API_URL;
  return supabaseUrl.replace(/\/$/, '');
}

/**
 * Build the full path for an API function call.
 * - Hosted (apiUrl === HOSTED_API_URL): `<apiUrl>/api/<functionName>`
 * - Community: `<apiUrl>/functions/v1/<functionName>`
 */
export function resolveApiPath(apiUrl: string, functionName: string): string {
  if (apiUrl === HOSTED_API_URL) {
    return `${apiUrl}/api/${functionName}`;
  }
  return `${apiUrl}/functions/v1/${functionName}`;
}

/**
 * Detect whether a config represents a hosted deployment.
 * Hosted mode: supabase_url matches HOSTED_SUPABASE_URL and
 * no service-role key is configured (hosted users never have one).
 */
export function isHostedMode(config: TeamindConfig): boolean {
  return (
    config.supabase_url === HOSTED_SUPABASE_URL &&
    (!config.supabase_service_role_key || config.supabase_service_role_key === '')
  );
}
