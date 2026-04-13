/**
 * Shared E2E registration fixture.
 *
 * Registers ONE org/project/member and caches the result for all test suites.
 * Reduces /api/register calls from 6 per run to 1 — stays well within the
 * 10/hour/IP rate limit even with repeated runs.
 */

import {
  registerTestOrg,
  getJwtToken,
  E2E_SUPABASE_URL,
  type E2ERegistration,
} from './helpers.js';

let promise: Promise<{ reg: E2ERegistration; jwt: string }> | null = null;

/**
 * Returns a shared registration + JWT token.
 * First call triggers registration; subsequent calls return the cached promise.
 */
export function getSharedRegistration(): Promise<{ reg: E2ERegistration; jwt: string }> {
  if (!promise) {
    promise = (async () => {
      const reg = await registerTestOrg('shared');
      const tokenResponse = await getJwtToken(
        E2E_SUPABASE_URL,
        reg.response.member_api_key,
        reg.response.project_id,
      );
      return { reg, jwt: tokenResponse.token };
    })();
  }
  return promise;
}
