/**
 * E2E Test 6: Multi-project isolation
 *
 * Verifies project-scoped data isolation:
 * - Create second project in the same org
 * - Store decision in project A
 * - Search in project B → should NOT find it
 * - Search in project A → should find it
 * - Cross-project search (all_projects) → should find it
 *
 * Requires: VALIS_E2E_API_URL, VALIS_E2E_SUPABASE_URL
 */

import { describe, it, expect, beforeAll } from 'vitest';
import {
  canRunE2E,
  registerTestOrg,
  getJwtToken,
  apiStore,
  apiSearch,
  apiCreateProject,
  retry,
  E2E_API_URL,
  E2E_SUPABASE_URL,
  TEST_RUN_ID,
  type E2ERegistration,
} from './helpers.js';

const describeE2E = canRunE2E() ? describe : describe.skip;

describeE2E('e2e: multi-project isolation', () => {
  let reg: E2ERegistration;
  let jwtProjectA: string;
  let jwtProjectB: string;
  let projectAId: string;
  let projectBId: string;

  const DECISION_IN_A =
    'Project A uses Redis for session caching with a 30-minute TTL and LRU eviction policy';
  const DECISION_IN_B =
    'Project B uses Memcached for API response caching with automatic key invalidation';

  beforeAll(async () => {
    // Register org with project A
    reg = await registerTestOrg('multi-proj');
    projectAId = reg.response.project_id;

    // Get JWT scoped to project A
    const tokenA = await getJwtToken(
      E2E_SUPABASE_URL,
      reg.response.member_api_key,
      projectAId,
    );
    jwtProjectA = tokenA.token;

    // Create project B in the same org
    const projectB = await apiCreateProject(
      E2E_API_URL,
      jwtProjectA,
      `e2e-project-B-${TEST_RUN_ID}`,
    );
    projectBId = projectB.project_id;

    // Get JWT scoped to project B
    const tokenB = await getJwtToken(
      E2E_SUPABASE_URL,
      reg.response.member_api_key,
      projectBId,
    );
    jwtProjectB = tokenB.token;
  });

  // -------------------------------------------------------------------------
  // Store in project A
  // -------------------------------------------------------------------------

  it('stores decision in project A', async () => {
    const result = await apiStore(E2E_API_URL, reg.response.member_api_key, {
      text: DECISION_IN_A,
      type: 'decision',
      summary: 'Redis for session caching in Project A',
      affects: ['caching', 'sessions', 'redis'],
      project_id: projectAId,
    });

    expect(result.stored).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Search in project A → should find it
  // -------------------------------------------------------------------------

  it('search in project A finds the decision', async () => {
    const result = await retry(
      async () => {
        const r = await apiSearch(E2E_API_URL, jwtProjectA, 'Redis session caching', {
          project_id: projectAId,
        });
        const match = r.results.find((res) =>
          res.detail.toLowerCase().includes('redis'),
        );
        return match ? r : null;
      },
      { timeout: 20_000, interval: 2_000, label: 'multi-search-A' },
    );

    const match = result.results.find((r) =>
      r.detail.toLowerCase().includes('redis'),
    );
    expect(match).toBeTruthy();
  });

  // -------------------------------------------------------------------------
  // Search in project B → should NOT find it
  // -------------------------------------------------------------------------

  it('search in project B does NOT find the project A decision', async () => {
    // First, make sure indexing is done by confirming project A search works
    await retry(
      async () => {
        const r = await apiSearch(E2E_API_URL, jwtProjectA, 'Redis session caching', {
          project_id: projectAId,
        });
        const match = r.results.find((res) =>
          res.detail.toLowerCase().includes('redis'),
        );
        return match ? r : null;
      },
      { timeout: 15_000, interval: 2_000, label: 'multi-wait-index' },
    );

    // Now search in project B — should not find project A's Redis decision
    const result = await apiSearch(E2E_API_URL, jwtProjectB, 'Redis session caching', {
      project_id: projectBId,
    });

    // None of the results should be about Redis (project A's content)
    const hasRedisFromA = result.results.some((r) =>
      r.detail.toLowerCase().includes('redis') &&
      r.detail.toLowerCase().includes('session caching'),
    );
    expect(hasRedisFromA).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Store in project B → separate content
  // -------------------------------------------------------------------------

  it('stores decision in project B (separate content)', async () => {
    const result = await apiStore(E2E_API_URL, reg.response.member_api_key, {
      text: DECISION_IN_B,
      type: 'decision',
      summary: 'Memcached for API caching in Project B',
      affects: ['caching', 'api'],
      project_id: projectBId,
    });

    expect(result.stored).toBe(1);
  });

  it('search in project B finds only project B content', async () => {
    const result = await retry(
      async () => {
        const r = await apiSearch(E2E_API_URL, jwtProjectB, 'Memcached API caching', {
          project_id: projectBId,
        });
        return r.results.length > 0 ? r : null;
      },
      { timeout: 15_000, interval: 2_000, label: 'multi-search-B-only' },
    );

    expect(result.results.length).toBeGreaterThan(0);
    const hasMemcached = result.results.some((r) =>
      r.detail.toLowerCase().includes('memcached'),
    );
    expect(hasMemcached).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Cross-project search (all_projects=true)
  // -------------------------------------------------------------------------

  it('cross-project search finds decisions from both projects', async () => {
    const result = await retry(
      async () => {
        const r = await apiSearch(E2E_API_URL, jwtProjectA, 'caching', {
          all_projects: true,
          limit: 20,
        });
        const hasA = r.results.some((res) =>
          res.detail.toLowerCase().includes('redis'),
        );
        const hasB = r.results.some((res) =>
          res.detail.toLowerCase().includes('memcached'),
        );
        return hasA && hasB ? r : null;
      },
      { timeout: 20_000, interval: 2_000, label: 'multi-cross-project' },
    );

    const hasRedis = result.results.some((r) =>
      r.detail.toLowerCase().includes('redis'),
    );
    const hasMemcached = result.results.some((r) =>
      r.detail.toLowerCase().includes('memcached'),
    );
    expect(hasRedis).toBe(true);
    expect(hasMemcached).toBe(true);
  });
}, 90_000);
