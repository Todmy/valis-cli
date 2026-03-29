/**
 * E2E Test 4: Decision lifecycle
 *
 * Verifies the full lifecycle flow:
 * - Store a decision (active)
 * - Search confirms it's active
 * - Deprecate it
 * - Search shows deprecated status
 * - Store a replacement
 * - Supersede the original
 * - Search shows superseded status
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
  apiChangeStatus,
  retry,
  E2E_API_URL,
  E2E_SUPABASE_URL,
  type E2ERegistration,
} from './helpers.js';

const describeE2E = canRunE2E() ? describe : describe.skip;

describeE2E('e2e: decision lifecycle', () => {
  let reg: E2ERegistration;
  let jwt: string;
  let originalDecisionId: string;

  const ORIGINAL_TEXT =
    'We use REST APIs for all external integrations with third-party payment processors';
  const REPLACEMENT_TEXT =
    'We migrated from REST to GraphQL for external payment processor integrations for better type safety and reduced over-fetching';

  beforeAll(async () => {
    reg = await registerTestOrg('lifecycle');

    const tokenResponse = await getJwtToken(
      E2E_SUPABASE_URL,
      reg.response.member_api_key,
      reg.response.project_id,
    );
    jwt = tokenResponse.token;
  });

  // -------------------------------------------------------------------------
  // Step 1: Store initial decision
  // -------------------------------------------------------------------------

  it('stores initial decision as active', async () => {
    const result = await apiStore(E2E_API_URL, reg.response.member_api_key, {
      text: ORIGINAL_TEXT,
      type: 'decision',
      summary: 'REST APIs for payment integrations',
      affects: ['api', 'payments', 'integrations'],
      project_id: reg.response.project_id,
    });

    expect(result.stored).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Step 2: Find the decision and verify it's active
  // -------------------------------------------------------------------------

  it('search returns the decision as active', async () => {
    const result = await retry(
      async () => {
        const r = await apiSearch(E2E_API_URL, jwt, 'REST payment processor', {
          project_id: reg.response.project_id,
        });
        const match = r.results.find((res) =>
          res.detail.toLowerCase().includes('rest api'),
        );
        return match ? r : null;
      },
      { timeout: 20_000, interval: 2_000, label: 'lifecycle-search-active' },
    );

    const match = result.results.find((r) =>
      r.detail.toLowerCase().includes('rest api'),
    );
    expect(match).toBeTruthy();
    originalDecisionId = match!.id;

    // Status should be active
    if (match!.status) {
      expect(match!.status).toBe('active');
    }
  });

  // -------------------------------------------------------------------------
  // Step 3: Deprecate
  // -------------------------------------------------------------------------

  it('deprecates the decision', async () => {
    const result = await apiChangeStatus(
      E2E_API_URL,
      jwt,
      originalDecisionId,
      'deprecated',
      'Migrating to GraphQL',
    );

    expect(result.decision_id).toBe(originalDecisionId);
    expect(result.old_status).toBe('active');
    expect(result.new_status).toBe('deprecated');
  });

  // -------------------------------------------------------------------------
  // Step 4: Search still finds it but shows deprecated
  // -------------------------------------------------------------------------

  it('search returns the deprecated decision with status', async () => {
    const result = await retry(
      async () => {
        const r = await apiSearch(E2E_API_URL, jwt, 'REST payment processor', {
          project_id: reg.response.project_id,
        });
        const match = r.results.find((res) => res.id === originalDecisionId);
        return match ? r : null;
      },
      { timeout: 15_000, interval: 2_000, label: 'lifecycle-search-deprecated' },
    );

    const match = result.results.find((r) => r.id === originalDecisionId);
    expect(match).toBeTruthy();
    if (match!.status) {
      expect(match!.status).toBe('deprecated');
    }
  });

  // -------------------------------------------------------------------------
  // Step 5: Store replacement decision
  // -------------------------------------------------------------------------

  it('stores a replacement decision', async () => {
    const result = await apiStore(E2E_API_URL, reg.response.member_api_key, {
      text: REPLACEMENT_TEXT,
      type: 'decision',
      summary: 'GraphQL for payment integrations',
      affects: ['api', 'payments', 'integrations', 'graphql'],
      project_id: reg.response.project_id,
    });

    expect(result.stored).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Step 6: Supersede the original
  // -------------------------------------------------------------------------

  it('supersedes the original decision', async () => {
    const result = await apiChangeStatus(
      E2E_API_URL,
      jwt,
      originalDecisionId,
      'superseded',
      'Replaced by GraphQL migration decision',
    );

    expect(result.decision_id).toBe(originalDecisionId);
    expect(result.old_status).toBe('deprecated');
    expect(result.new_status).toBe('superseded');
  });

  // -------------------------------------------------------------------------
  // Step 7: Search shows superseded status
  // -------------------------------------------------------------------------

  it('search returns the superseded decision with status', async () => {
    const result = await retry(
      async () => {
        const r = await apiSearch(E2E_API_URL, jwt, 'REST payment processor', {
          project_id: reg.response.project_id,
        });
        const match = r.results.find((res) => res.id === originalDecisionId);
        return match ? r : null;
      },
      { timeout: 15_000, interval: 2_000, label: 'lifecycle-search-superseded' },
    );

    const match = result.results.find((r) => r.id === originalDecisionId);
    expect(match).toBeTruthy();
    if (match!.status) {
      expect(match!.status).toBe('superseded');
    }
  });

  // -------------------------------------------------------------------------
  // Step 8: Replacement decision is findable and active
  // -------------------------------------------------------------------------

  it('replacement decision appears in search as active', async () => {
    const result = await retry(
      async () => {
        const r = await apiSearch(E2E_API_URL, jwt, 'GraphQL payment processor', {
          project_id: reg.response.project_id,
        });
        return r.results.length > 0 ? r : null;
      },
      { timeout: 15_000, interval: 2_000, label: 'lifecycle-search-replacement' },
    );

    expect(result.results.length).toBeGreaterThan(0);
    const match = result.results.find((r) =>
      r.detail.toLowerCase().includes('graphql'),
    );
    expect(match).toBeTruthy();
    if (match!.status) {
      expect(match!.status).toBe('active');
    }
  });
}, 90_000);
