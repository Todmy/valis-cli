/**
 * E2E Test 3: MCP tool flow
 *
 * Verifies the full tool chain works end-to-end:
 * - Store a decision (via /api/seed)
 * - Search for it (via /api/search)
 * - Context query returns relevant results
 * - Lifecycle changes work (via /api/change-status)
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

describeE2E('e2e: MCP tool flow', () => {
  let reg: E2ERegistration;
  let jwt: string;

  beforeAll(async () => {
    reg = await registerTestOrg('mcp-tools');

    const tokenResponse = await getJwtToken(
      E2E_SUPABASE_URL,
      reg.response.member_api_key,
      reg.response.project_id,
    );
    jwt = tokenResponse.token;
  });

  // -------------------------------------------------------------------------
  // valis_store tool
  // -------------------------------------------------------------------------

  it('valis_store: stores a decision with all fields', async () => {
    const result = await apiStore(E2E_API_URL, reg.response.member_api_key, {
      text: 'We adopted TypeScript strict mode across all packages to catch null-safety issues at compile time',
      type: 'decision',
      summary: 'TypeScript strict mode enforced',
      affects: ['typescript', 'build', 'developer-experience'],
      project_id: reg.response.project_id,
    });

    expect(result.stored).toBe(1);
  });

  it('valis_store: stores a pattern', async () => {
    const result = await apiStore(E2E_API_URL, reg.response.member_api_key, {
      text: 'Repository pattern used for all database access with interface-based dependency injection for testability',
      type: 'pattern',
      summary: 'Repository pattern for DB access',
      affects: ['architecture', 'testing', 'database'],
      project_id: reg.response.project_id,
    });

    expect(result.stored).toBe(1);
  });

  // -------------------------------------------------------------------------
  // valis_search tool
  // -------------------------------------------------------------------------

  it('valis_search: finds stored decision', async () => {
    const result = await retry(
      async () => {
        const r = await apiSearch(E2E_API_URL, jwt, 'TypeScript strict mode', {
          project_id: reg.response.project_id,
        });
        const match = r.results.find((res) =>
          res.detail.toLowerCase().includes('typescript strict'),
        );
        return match ? r : null;
      },
      { timeout: 20_000, interval: 2_000, label: 'mcp-search' },
    );

    const match = result.results.find((r) =>
      r.detail.toLowerCase().includes('typescript'),
    );
    expect(match).toBeTruthy();
  });

  it('valis_search: filters by type=pattern', async () => {
    const result = await retry(
      async () => {
        const r = await apiSearch(E2E_API_URL, jwt, 'repository pattern', {
          type: 'pattern',
          project_id: reg.response.project_id,
        });
        return r.results.length > 0 ? r : null;
      },
      { timeout: 15_000, interval: 2_000, label: 'mcp-search-pattern' },
    );

    expect(result.results.length).toBeGreaterThan(0);
    for (const r of result.results) {
      expect(r.type).toBe('pattern');
    }
  });

  // -------------------------------------------------------------------------
  // valis_context tool (via search — same underlying mechanism)
  // -------------------------------------------------------------------------

  it('valis_context: returns relevant decisions for a task description', async () => {
    const result = await retry(
      async () => {
        const r = await apiSearch(
          E2E_API_URL,
          jwt,
          'Setting up build pipeline with TypeScript configuration',
          { project_id: reg.response.project_id, limit: 20 },
        );
        return r.results.length > 0 ? r : null;
      },
      { timeout: 15_000, interval: 2_000, label: 'mcp-context' },
    );

    expect(result.results.length).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------------
  // valis_lifecycle tool
  // -------------------------------------------------------------------------

  it('valis_lifecycle: deprecate and promote work', async () => {
    // Store a decision that we will manipulate
    await apiStore(E2E_API_URL, reg.response.member_api_key, {
      text: 'We use ESLint with strict rules for code quality enforcement across all TypeScript packages',
      type: 'decision',
      summary: 'ESLint strict rules enforced',
      affects: ['linting', 'code-quality'],
      project_id: reg.response.project_id,
    });

    // Wait for it to appear in search
    const searchResult = await retry(
      async () => {
        const r = await apiSearch(E2E_API_URL, jwt, 'ESLint strict rules', {
          project_id: reg.response.project_id,
        });
        const match = r.results.find((res) =>
          res.detail.toLowerCase().includes('eslint'),
        );
        return match ? r : null;
      },
      { timeout: 20_000, interval: 2_000, label: 'lifecycle-find' },
    );

    const decision = searchResult.results.find((r) =>
      r.detail.toLowerCase().includes('eslint'),
    );
    expect(decision).toBeTruthy();
    const decisionId = decision!.id;

    // Deprecate
    const deprecateResult = await apiChangeStatus(
      E2E_API_URL,
      jwt,
      decisionId,
      'deprecated',
      'Replaced by biome',
    );
    expect(deprecateResult.decision_id).toBe(decisionId);
    expect(deprecateResult.new_status).toBe('deprecated');

    // Promote back to active
    const promoteResult = await apiChangeStatus(
      E2E_API_URL,
      jwt,
      decisionId,
      'active',
      'Reinstated after review',
    );
    expect(promoteResult.decision_id).toBe(decisionId);
    expect(promoteResult.new_status).toBe('active');
  });
}, 90_000);
