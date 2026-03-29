/**
 * E2E Test 5: Rate limits
 *
 * Verifies that free tier limits are enforced:
 * - check-usage returns allowed=true for a fresh org
 * - check-usage reports the correct plan (free)
 * - Free tier limits: 100 decisions, 100 searches
 *
 * Note: We don't actually exhaust 100 decisions in E2E tests (too slow).
 * Instead we verify:
 * 1. The check-usage endpoint works correctly
 * 2. The response shape matches the expected contract
 * 3. A fresh org is on the free plan and allowed
 *
 * Requires: VALIS_E2E_API_URL, VALIS_E2E_SUPABASE_URL
 */

import { describe, it, expect, beforeAll } from 'vitest';
import {
  canRunE2E,
  registerTestOrg,
  getJwtToken,
  apiCheckUsage,
  apiStore,
  E2E_API_URL,
  E2E_SUPABASE_URL,
  type E2ERegistration,
} from './helpers.js';

const describeE2E = canRunE2E() ? describe : describe.skip;

describeE2E('e2e: rate limits', () => {
  let reg: E2ERegistration;
  let jwt: string;

  beforeAll(async () => {
    reg = await registerTestOrg('rate-limits');

    const tokenResponse = await getJwtToken(
      E2E_SUPABASE_URL,
      reg.response.member_api_key,
      reg.response.project_id,
    );
    jwt = tokenResponse.token;
  });

  // -------------------------------------------------------------------------
  // check-usage for store
  // -------------------------------------------------------------------------

  it('check-usage allows store for fresh free-tier org', async () => {
    const result = await apiCheckUsage(
      E2E_API_URL,
      jwt,
      reg.response.org_id,
      'store',
    );

    expect(result.allowed).toBe(true);
    expect(result.plan).toBe('free');
  });

  // -------------------------------------------------------------------------
  // check-usage for search
  // -------------------------------------------------------------------------

  it('check-usage allows search for fresh free-tier org', async () => {
    const result = await apiCheckUsage(
      E2E_API_URL,
      jwt,
      reg.response.org_id,
      'search',
    );

    expect(result.allowed).toBe(true);
    expect(result.plan).toBe('free');
  });

  // -------------------------------------------------------------------------
  // Usage increments after operations
  // -------------------------------------------------------------------------

  it('check-usage still allows after a few store operations', async () => {
    // Store 3 decisions
    for (let i = 0; i < 3; i++) {
      await apiStore(E2E_API_URL, reg.response.member_api_key, {
        text: `Rate limit test decision number ${i} about infrastructure scaling patterns and deployment strategies`,
        type: 'decision',
        summary: `Rate limit test ${i}`,
        affects: ['infrastructure'],
        project_id: reg.response.project_id,
      });
    }

    // Check usage — should still be allowed (well under 100 limit)
    const result = await apiCheckUsage(
      E2E_API_URL,
      jwt,
      reg.response.org_id,
      'store',
    );

    expect(result.allowed).toBe(true);
    expect(result.plan).toBe('free');
  });

  // -------------------------------------------------------------------------
  // Response shape validation
  // -------------------------------------------------------------------------

  it('check-usage response has expected shape', async () => {
    const result = await apiCheckUsage(
      E2E_API_URL,
      jwt,
      reg.response.org_id,
      'store',
    );

    expect(typeof result.allowed).toBe('boolean');
    if (result.plan !== undefined) {
      expect(typeof result.plan).toBe('string');
    }
  });

  // -------------------------------------------------------------------------
  // Registration endpoint validation (not rate limit exhaustion)
  // -------------------------------------------------------------------------

  it('registration rejects missing fields with 400', async () => {
    const res = await fetch(`${E2E_API_URL}/api/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBeTruthy();
  });
}, 30_000);
