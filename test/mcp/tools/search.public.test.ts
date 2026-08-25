/**
 * Feature 033 — public-KB cross-org read tests for `valis_search`.
 *
 * Verifies that the new `target_project_id` arg correctly gates cross-org
 * reads via the `resolveReadAccess` helper:
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

vi.mock('../../../src/cloud/qdrant.js', async () => ({
  mmrRerank: (
    await vi.importActual<typeof import('../../../src/cloud/qdrant/search.js')>(
      '../../../src/cloud/qdrant/search.js',
    )
  ).mmrRerank,
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
  assertServiceRoleClient: (c: unknown) => c,
  canReadProject: vi.fn().mockResolvedValue(true),
  resolveReadAccess: vi.fn(),
}));

vi.mock('../../../src/cloud/supabase/audit.js', () => ({
  storeAuditEntry: vi.fn().mockResolvedValue({}),
}));

vi.mock('../../../src/cloud/api-url.js', () => ({
  isHostedMode: vi.fn().mockReturnValue(false),
}));

import { handleSearch } from '../../../src/mcp/tools/search.js';
import { handleConsultAgent } from '../../../src/mcp/tools/agents.js';
import { getAgent } from '../../../src/mcp/agents/index.js';
import { resolveReadAccess } from '../../../src/lib/project-access.js';
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
    vi.mocked(resolveReadAccess).mockResolvedValueOnce('allow');

    const result = await handleSearch(
      { query: 'auth', target_project_id: PUBLIC_TARGET },
      httpServerOverride,
    );

    expect(resolveReadAccess).toHaveBeenCalledWith(
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
    vi.mocked(resolveReadAccess).mockResolvedValueOnce('allow');

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
    vi.mocked(resolveReadAccess).mockResolvedValueOnce('deny');

    await handleSearch(
      { query: 'auth', target_project_id: PRIVATE_TARGET },
      httpServerOverride,
    );

    expect(storeAuditEntry).not.toHaveBeenCalled();
  });

  it('search still succeeds when audit emit fails (Constitution III non-blocking)', async () => {
    vi.mocked(resolveReadAccess).mockResolvedValueOnce('allow');
    vi.mocked(storeAuditEntry).mockRejectedValueOnce(new Error('audit table down'));

    const result = await handleSearch(
      { query: 'auth', target_project_id: PUBLIC_TARGET },
      httpServerOverride,
    );

    // Search response still produced; audit failure is logged but not surfaced.
    expect(result.results.length).toBeGreaterThan(0);
  });

  it('returns empty results when target project is private (non-member)', async () => {
    vi.mocked(resolveReadAccess).mockResolvedValueOnce('deny');

    const result = await handleSearch(
      { query: 'auth', target_project_id: PRIVATE_TARGET },
      httpServerOverride,
    );

    expect(resolveReadAccess).toHaveBeenCalled();
    expect(result.results).toEqual([]);
    // Qdrant must NOT be touched on deny — indistinguishable from "no project".
    expect(hybridSearch).not.toHaveBeenCalled();
  });

  it('returns empty results when target project does not exist', async () => {
    // resolveReadAccess returns false for non-existent target (per helper contract)
    vi.mocked(resolveReadAccess).mockResolvedValueOnce('deny');

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

    expect(resolveReadAccess).not.toHaveBeenCalled();
    expect(result.results).toEqual([]);
    expect(hybridSearch).not.toHaveBeenCalled();
  });

  it('does not trigger the gate when target_project_id equals current scope', async () => {
    // Caller queries their own project with target_project_id set to it.
    // No cross-org read — should fall through to legacy path without calling
    // resolveReadAccess.
    const result = await handleSearch(
      { query: 'auth', target_project_id: 'own-project-id' },
      httpServerOverride,
    );

    expect(resolveReadAccess).not.toHaveBeenCalled();
    expect(result.results.length).toBeGreaterThan(0);
  });

  it('preserves legacy behaviour when target_project_id is omitted', async () => {
    const result = await handleSearch({ query: 'auth' }, httpServerOverride);

    expect(resolveReadAccess).not.toHaveBeenCalled();
    expect(result.results.length).toBeGreaterThan(0);
    const callArgs = vi.mocked(hybridSearch).mock.calls[0];
    const searchOptions = callArgs[3] as { projectId?: string };
    expect(searchOptions.projectId).toBe('own-project-id');
  });
});

/**
 * Review HIGH (308) — forced / per-agent scope must pass resolveReadAccess.
 *
 * The per-agent MCP endpoint sets `forceProjectId` → `config.project_id =
 * AGENT_PID`. Before the fix, `valis_search` only gated on
 * `target_project_id && target_project_id !== projectId`, so:
 *   - a direct valis_search through the forced endpoint (no target) skipped the
 *     gate entirely, and
 *   - handleConsultAgent passed `target_project_id = AGENT_PID` which EQUALS the
 *     forced scope, so the differ-check was false and the gate was skipped.
 * Result: a PRIVATE forced project would be readable by any authenticated
 * non-member. These tests prove the bypass and lock the fix.
 */
describe('handleSearch — forced/agent scope gate (review HIGH 308)', () => {
  const AGENT_PID = getAgent('negotiator')!.project_id;

  // Mirrors what the per-agent endpoint builds: forced scope replaces
  // project_id AND raises the forced_project_id signal.
  const forcedAgentOverride = {
    ...httpServerOverride,
    project_id: AGENT_PID,
    forced_project_id: AGENT_PID,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('forced scope to a denied project returns EMPTY (proves the bypass)', async () => {
    vi.mocked(resolveReadAccess).mockResolvedValueOnce('deny');

    // Direct valis_search through the forced per-agent endpoint, NO target arg.
    const result = await handleSearch({ query: 'auth' }, forcedAgentOverride);

    expect(resolveReadAccess).toHaveBeenCalledWith(
      expect.anything(),
      'caller-member-id',
      AGENT_PID,
    );
    expect(result.results).toEqual([]);
    expect(hybridSearch).not.toHaveBeenCalled();
  });

  it('consult_agent on a denied forced scope returns EMPTY (target == scope)', async () => {
    vi.mocked(resolveReadAccess).mockResolvedValueOnce('deny');

    const result = (await handleConsultAgent(
      { agent: 'negotiator', query: 'how do I anchor?' },
      forcedAgentOverride,
    )) as { results: unknown[] };

    expect(resolveReadAccess).toHaveBeenCalledWith(
      expect.anything(),
      'caller-member-id',
      AGENT_PID,
    );
    expect(result.results).toEqual([]);
    expect(hybridSearch).not.toHaveBeenCalled();
  });

  it('allowed forced scope returns results scoped to the forced project', async () => {
    vi.mocked(resolveReadAccess).mockResolvedValueOnce('allow');

    const result = await handleSearch({ query: 'auth' }, forcedAgentOverride);

    expect(resolveReadAccess).toHaveBeenCalledWith(
      expect.anything(),
      'caller-member-id',
      AGENT_PID,
    );
    expect(result.results.length).toBeGreaterThan(0);
    const callArgs = vi.mocked(hybridSearch).mock.calls[0];
    const searchOptions = callArgs[3] as { projectId?: string };
    expect(searchOptions.projectId).toBe(AGENT_PID);
  });

  it('caller own membership default (no force, no target) skips resolveReadAccess', async () => {
    const result = await handleSearch({ query: 'auth' }, httpServerOverride);

    expect(resolveReadAccess).not.toHaveBeenCalled();
    expect(result.results.length).toBeGreaterThan(0);
  });
});

/**
 * gh#330 — an unanswerable access check must not read as a denial.
 *
 * `canReadProject` folded every Supabase failure into `false`, so an outage
 * reached the caller as the FR-006 empty response: "no results / no such
 * project". These tests lock the tri-state routing — `'unavailable'` surfaces
 * the server-mode backend envelope, `'deny'` stays byte-for-byte the silent
 * empty it has always been.
 */
describe('handleSearch — read-access unavailable vs denied (gh#330)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reports a backend error when the access check is unavailable', async () => {
    vi.mocked(resolveReadAccess).mockResolvedValueOnce('unavailable');

    const result = await handleSearch(
      { query: 'auth', target_project_id: PUBLIC_TARGET },
      httpServerOverride,
    );

    expect(result.results).toEqual([]);
    expect(result.backend_unavailable).toBe(true);
    expect(result.error_message).toBeTruthy();
    // Server mode never emits the CLI-stdio `offline` cue (BUG #84 / T4.1).
    expect(result.offline).toBeUndefined();
    // The question was never answered — no query may run.
    expect(hybridSearch).not.toHaveBeenCalled();
    // And no cross-org read happened, so nothing to audit.
    expect(storeAuditEntry).not.toHaveBeenCalled();
  });

  it('keeps deny indistinguishable from "no results" (FR-006 unchanged)', async () => {
    vi.mocked(resolveReadAccess).mockResolvedValueOnce('deny');

    const result = await handleSearch(
      { query: 'auth', target_project_id: PRIVATE_TARGET },
      httpServerOverride,
    );

    expect(result).toEqual({ results: [] });
  });

  it('an unavailable forced-scope check is an error, not a silent empty', async () => {
    vi.mocked(resolveReadAccess).mockResolvedValueOnce('unavailable');

    const AGENT_PID = getAgent('negotiator')!.project_id;
    const result = await handleSearch(
      { query: 'auth' },
      { ...httpServerOverride, project_id: AGENT_PID, forced_project_id: AGENT_PID },
    );

    expect(result.backend_unavailable).toBe(true);
    expect(result.results).toEqual([]);
    expect(hybridSearch).not.toHaveBeenCalled();
  });
});
