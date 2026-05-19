/**
 * Feature 033 — public-KB cross-org read tests for `valis_search`.
 *
 * Verifies that the new `target_project_id` arg correctly gates cross-org
 * reads via the `canReadProject` helper:
 *
 *   - non-member queries public project    → results returned, projectId = target
 *   - non-member queries private project   → empty results, no Qdrant call
 *   - non-member queries non-existent      → empty results (indistinguishable)
 *   - missing service-role creds (stdio)   → empty results (silent deny)
 *   - target equals current scope          → legacy path (no gate triggered)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/config/store.js', () => ({
  loadConfig: vi.fn().mockResolvedValue({
    org_id: 'caller-org',
    qdrant_url: 'https://test.qdrant.io',
    qdrant_api_key: 'test-key',
  }),
}));

vi.mock('../../../src/cloud/qdrant.js', () => ({
  getQdrantClient: vi.fn().mockReturnValue({}),
  hybridSearch: vi.fn().mockResolvedValue([
    {
      id: 'result-1',
      score: 0.95,
      type: 'decision',
      summary: 'Public decision from target project',
      detail: 'Some content',
      author: 'publisher',
      affects: ['ux'],
      created_at: '2026-05-01T12:00:00Z',
      confidence: 0.9,
      pinned: false,
      depends_on: [],
    },
  ]),
}));

vi.mock('../../../src/billing/usage.js', () => ({
  checkUsageBeforeSearch: vi.fn().mockResolvedValue({ allowed: true }),
  incrementUsage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../src/cloud/supabase.js', () => ({
  getSupabaseClient: vi.fn().mockReturnValue({}),
  getSupabaseJwtClient: vi.fn().mockReturnValue({}),
  getDecisionsByIds: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../../src/lib/project-access.js', () => ({
  canReadProject: vi.fn(),
}));

vi.mock('../../../src/cloud/supabase/audit.js', () => ({
  storeAuditEntry: vi.fn().mockResolvedValue({}),
}));

vi.mock('../../../src/cloud/api-url.js', () => ({
  isHostedMode: vi.fn().mockReturnValue(false),
}));

import { handleSearch } from '../../../src/mcp/tools/search.js';
import { canReadProject } from '../../../src/lib/project-access.js';
import { hybridSearch } from '../../../src/cloud/qdrant.js';
import { storeAuditEntry } from '../../../src/cloud/supabase/audit.js';

const httpServerOverride = {
  org_id: 'caller-org',
  member_id: 'caller-member-id',
  author_name: 'Caller',
  role: 'project_member',
  auth_mode: 'jwt' as const,
  supabase_url: 'https://test.supabase.co',
  supabase_service_role_key: 'srv-key',
  qdrant_url: 'https://test.qdrant.io',
  qdrant_api_key: 'test-key',
  api_key: 'tok',
  member_api_key: 'tok',
  project_id: 'own-project-id',
};

const PUBLIC_TARGET = 'public-target-project-id';
const PRIVATE_TARGET = 'private-target-project-id';

describe('handleSearch — public-KB cross-org reads (feature 033)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns results when target project is public', async () => {
    vi.mocked(canReadProject).mockResolvedValueOnce(true);

    const result = await handleSearch(
      { query: 'auth', target_project_id: PUBLIC_TARGET },
      httpServerOverride,
    );

    expect(canReadProject).toHaveBeenCalledWith(
      expect.anything(),
      'caller-member-id',
      PUBLIC_TARGET,
    );
    expect(result.results.length).toBeGreaterThan(0);
    // Qdrant search ran with the *target* projectId, not the caller's own scope.
    // hybridSearch(client, orgId, query, options) — options is arg index 3.
    expect(hybridSearch).toHaveBeenCalled();
    const callArgs = vi.mocked(hybridSearch).mock.calls[0];
    const searchOptions = callArgs[3] as { projectId?: string };
    expect(searchOptions.projectId).toBe(PUBLIC_TARGET);
  });

  it('emits a cross_org_read audit row on successful cross-org search', async () => {
    vi.mocked(canReadProject).mockResolvedValueOnce(true);

    await handleSearch(
      { query: 'auth', target_project_id: PUBLIC_TARGET },
      httpServerOverride,
    );

    expect(storeAuditEntry).toHaveBeenCalledTimes(1);
    const auditCall = vi.mocked(storeAuditEntry).mock.calls[0][1];
    expect(auditCall).toMatchObject({
      action: 'cross_org_read',
      project_id: PUBLIC_TARGET,
      member_id: 'caller-member-id',
      target_type: 'project',
      target_id: PUBLIC_TARGET,
      new_state: { tool: 'valis_search' },
    });
  });

  it('does NOT emit a cross_org_read audit row when access is denied', async () => {
    vi.mocked(canReadProject).mockResolvedValueOnce(false);

    await handleSearch(
      { query: 'auth', target_project_id: PRIVATE_TARGET },
      httpServerOverride,
    );

    expect(storeAuditEntry).not.toHaveBeenCalled();
  });

  it('search still succeeds when audit emit fails (Constitution III non-blocking)', async () => {
    vi.mocked(canReadProject).mockResolvedValueOnce(true);
    vi.mocked(storeAuditEntry).mockRejectedValueOnce(new Error('audit table down'));

    const result = await handleSearch(
      { query: 'auth', target_project_id: PUBLIC_TARGET },
      httpServerOverride,
    );

    // Search response still produced; audit failure is logged but not surfaced.
    expect(result.results.length).toBeGreaterThan(0);
  });

  it('returns empty results when target project is private (non-member)', async () => {
    vi.mocked(canReadProject).mockResolvedValueOnce(false);

    const result = await handleSearch(
      { query: 'auth', target_project_id: PRIVATE_TARGET },
      httpServerOverride,
    );

    expect(canReadProject).toHaveBeenCalled();
    expect(result.results).toEqual([]);
    // Qdrant must NOT be touched on deny — indistinguishable from "no project".
    expect(hybridSearch).not.toHaveBeenCalled();
  });

  it('returns empty results when target project does not exist', async () => {
    // canReadProject returns false for non-existent target (per helper contract)
    vi.mocked(canReadProject).mockResolvedValueOnce(false);

    const result = await handleSearch(
      { query: 'auth', target_project_id: 'does-not-exist-id' },
      httpServerOverride,
    );

    expect(result.results).toEqual([]);
    expect(hybridSearch).not.toHaveBeenCalled();
  });

  it('returns empty results in stdio mode (no service-role creds) when target differs', async () => {
    // No configOverride → stdio path → no service-role-key → silent deny.
    const result = await handleSearch({
      query: 'auth',
      target_project_id: PUBLIC_TARGET,
    });

    expect(canReadProject).not.toHaveBeenCalled();
    expect(result.results).toEqual([]);
    expect(hybridSearch).not.toHaveBeenCalled();
  });

  it('does not trigger the gate when target_project_id equals current scope', async () => {
    // Caller queries their own project with target_project_id set to it.
    // No cross-org read — should fall through to legacy path without calling
    // canReadProject.
    const result = await handleSearch(
      { query: 'auth', target_project_id: 'own-project-id' },
      httpServerOverride,
    );

    expect(canReadProject).not.toHaveBeenCalled();
    expect(result.results.length).toBeGreaterThan(0);
  });

  it('preserves legacy behaviour when target_project_id is omitted', async () => {
    const result = await handleSearch({ query: 'auth' }, httpServerOverride);

    expect(canReadProject).not.toHaveBeenCalled();
    expect(result.results.length).toBeGreaterThan(0);
    const callArgs = vi.mocked(hybridSearch).mock.calls[0];
    const searchOptions = callArgs[3] as { projectId?: string };
    expect(searchOptions.projectId).toBe('own-project-id');
  });
});
