/**
 * E2E Test 2: valis store + valis search
 *
 * Verifies:
 * - Store a decision via the /api/seed endpoint
 * - Search for it via /api/search, verify it comes back
 * - Test with different query types
 * - Verify search result shape
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
  retry,
  E2E_API_URL,
  E2E_SUPABASE_URL,
  type E2ERegistration,
} from './helpers.js';

const describeE2E = canRunE2E() ? describe : describe.skip;

describeE2E('e2e: store + search', () => {
  let reg: E2ERegistration;
  let jwt: string;

  const DECISION_TEXT =
    'We chose PostgreSQL over MongoDB for user data because we need ACID transactions and strong relational integrity for billing records';
  const DECISION_SUMMARY = 'Chose PostgreSQL for user data';
  const DECISION_AFFECTS = ['database', 'billing', 'backend'];

  beforeAll(async () => {
    reg = await registerTestOrg('store-search');

    // Get JWT for authenticated search calls
    const tokenResponse = await getJwtToken(
      E2E_SUPABASE_URL,
      reg.response.member_api_key,
      reg.response.project_id,
    );
    jwt = tokenResponse.token;
  });

  // -------------------------------------------------------------------------
  // Store
  // -------------------------------------------------------------------------

  it('stores a decision successfully via seed endpoint', async () => {
    const result = await apiStore(E2E_API_URL, reg.response.member_api_key, {
      text: DECISION_TEXT,
      type: 'decision',
      summary: DECISION_SUMMARY,
      affects: DECISION_AFFECTS,
      project_id: reg.response.project_id,
    });

    expect(result.stored).toBe(1);
    expect(result.skipped).toBe(0);
  });

  it('stores a constraint', async () => {
    const result = await apiStore(E2E_API_URL, reg.response.member_api_key, {
      text: 'All API responses must complete within 500ms p99 latency for the billing service',
      type: 'constraint',
      summary: '500ms p99 latency requirement',
      affects: ['performance', 'billing'],
      project_id: reg.response.project_id,
    });

    expect(result.stored).toBe(1);
  });

  it('stores a lesson', async () => {
    const result = await apiStore(E2E_API_URL, reg.response.member_api_key, {
      text: 'Connection pooling with PgBouncer reduced database connection overhead by 80% in our billing microservice',
      type: 'lesson',
      summary: 'PgBouncer reduces connection overhead',
      affects: ['database', 'performance'],
      project_id: reg.response.project_id,
    });

    expect(result.stored).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Search — with retry for Qdrant indexing latency
  // -------------------------------------------------------------------------

  it('finds stored decision by semantic query', async () => {
    const result = await retry(
      async () => {
        const r = await apiSearch(E2E_API_URL, jwt, 'PostgreSQL database choice', {
          project_id: reg.response.project_id,
          limit: 10,
        });
        return r.results.length > 0 ? r : null;
      },
      { timeout: 20_000, interval: 2_000, label: 'search-semantic' },
    );

    expect(result.results.length).toBeGreaterThan(0);

    // At least one result should mention PostgreSQL
    const hasPostgres = result.results.some((r) =>
      r.detail.toLowerCase().includes('postgresql'),
    );
    expect(hasPostgres).toBe(true);
  });

  it('finds decision by keyword query', async () => {
    const result = await retry(
      async () => {
        const r = await apiSearch(E2E_API_URL, jwt, 'ACID transactions billing', {
          project_id: reg.response.project_id,
        });
        return r.results.length > 0 ? r : null;
      },
      { timeout: 15_000, interval: 2_000, label: 'search-keyword' },
    );

    expect(result.results.length).toBeGreaterThan(0);
  });

  it('filters search by type', async () => {
    const result = await retry(
      async () => {
        const r = await apiSearch(E2E_API_URL, jwt, 'latency performance', {
          type: 'constraint',
          project_id: reg.response.project_id,
        });
        return r.results.length > 0 ? r : null;
      },
      { timeout: 15_000, interval: 2_000, label: 'search-type-filter' },
    );

    expect(result.results.length).toBeGreaterThan(0);
    // All results should be constraints when filtered
    for (const r of result.results) {
      expect(r.type).toBe('constraint');
    }
  });

  it('returns empty or low-score results for unrelated query', async () => {
    // Wait for indexing to complete by confirming a known query works
    await retry(
      async () => {
        const r = await apiSearch(E2E_API_URL, jwt, 'PostgreSQL', {
          project_id: reg.response.project_id,
        });
        return r.results.length > 0 ? r : null;
      },
      { timeout: 15_000, interval: 2_000, label: 'wait-for-index' },
    );

    // Search for something completely unrelated
    const result = await apiSearch(
      E2E_API_URL,
      jwt,
      'quantum computing neural interface blockchain',
      { project_id: reg.response.project_id, limit: 5 },
    );

    // Should either return no results or very low-score results
    if (result.results.length > 0) {
      expect(result.results[0].score).toBeLessThan(0.8);
    }
  });

  // -------------------------------------------------------------------------
  // Search result shape
  // -------------------------------------------------------------------------

  it('search result has expected fields', async () => {
    const result = await retry(
      async () => {
        const r = await apiSearch(E2E_API_URL, jwt, 'PostgreSQL', {
          project_id: reg.response.project_id,
        });
        return r.results.length > 0 ? r : null;
      },
      { timeout: 15_000, interval: 2_000, label: 'search-shape' },
    );

    const first = result.results[0];
    expect(first.id).toBeTruthy();
    expect(typeof first.score).toBe('number');
    expect(first.type).toBeTruthy();
    expect(first.detail).toBeTruthy();
  });
}, 60_000); // 60s timeout for the whole suite — indexing can be slow
