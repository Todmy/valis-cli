import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../src/config/store.js', () => ({
  loadConfig: vi.fn().mockResolvedValue({
    org_id: 'test-org-id',
    qdrant_url: 'https://test.qdrant.io',
    qdrant_api_key: 'test-key',
  }),
}));

// Mock the qdrant barrel but keep the REAL pure `mmrRerank` (handleSearch now
// imports it from here as the final-transform diversifier). It's side-effect-
// free, so wiring the genuine implementation keeps these tests production-faithful.
vi.mock('../../../src/cloud/qdrant.js', async () => {
  const { mmrRerank } = await vi.importActual<typeof import('../../../src/cloud/qdrant/search.js')>(
    '../../../src/cloud/qdrant/search.js',
  );
  return {
    mmrRerank,
    getQdrantClient: vi.fn().mockReturnValue({}),
    hybridSearch: vi.fn().mockResolvedValue([
      {
        id: 'result-1',
        score: 0.95,
        type: 'decision',
        summary: 'Chose PostgreSQL',
        detail: 'We chose PostgreSQL for user data',
        author: 'olena',
        affects: ['database'],
        created_at: '2026-03-20T14:30:00Z',
        confidence: 0.8,
        pinned: false,
        depends_on: [],
      },
    ]),
  };
});

vi.mock('../../../src/billing/usage.js', () => ({
  checkUsageBeforeSearch: vi.fn().mockResolvedValue({ allowed: true }),
}));

import { handleSearch } from '../../../src/mcp/tools/search.js';

describe('handleSearch', () => {
  it('returns search results', async () => {
    const result = await handleSearch({ query: 'database' });
    expect(result.results).toHaveLength(1);
    expect(result.results[0].type).toBe('decision');
  });

  it('returns empty results when not configured', async () => {
    const { loadConfig } = await import('../../../src/config/store.js');
    vi.mocked(loadConfig).mockResolvedValueOnce(null);

    const result = await handleSearch({ query: 'test' });
    expect(result.results).toHaveLength(0);
    expect(result.note).toContain('Not configured');
  });

  // #25/BUG-#118 — project_scope_mismatch defensive signal
  const serverOverride = {
    org_id: 'test-org-id',
    member_id: 'member-1',
    author_name: 'Test',
    role: 'project_admin',
    auth_mode: 'jwt' as const,
    supabase_url: 'https://test.supabase.co',
    supabase_service_role_key: 'srv-key',
    qdrant_url: 'https://test.qdrant.io',
    qdrant_api_key: 'test-key',
    api_key: 'tok',
    member_api_key: 'tok',
    project_id: 'project-A',
  };

  it('returns project_scope_mismatch when args.project_id differs from session scope', async () => {
    const result = await handleSearch(
      { query: 'database', project_id: 'project-B' },
      serverOverride,
    );
    expect(result.project_scope_mismatch).toEqual({
      session_project_id: 'project-A',
      current_project_id: 'project-B',
      action_required: 'restart_session',
    });
    // Results still returned — warning is informational, not a hard block.
    expect(result.results.length).toBeGreaterThan(0);
  });

  it('omits project_scope_mismatch when args.project_id matches session scope', async () => {
    const result = await handleSearch(
      { query: 'database', project_id: 'project-A' },
      serverOverride,
    );
    expect(result.project_scope_mismatch).toBeUndefined();
  });

  it('omits project_scope_mismatch when args.project_id is absent', async () => {
    const result = await handleSearch({ query: 'database' }, serverOverride);
    expect(result.project_scope_mismatch).toBeUndefined();
  });

  it('omits project_scope_mismatch in CLI stdio mode (no configOverride / no JWT scope)', async () => {
    const result = await handleSearch({ query: 'database', project_id: 'project-B' });
    expect(result.project_scope_mismatch).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // Cross-project leak fix (ec41f06 + c610422) — regression guards
  // ---------------------------------------------------------------------------

  it('fails closed with project_scope_required when no scope source is set', async () => {
    // No configOverride.project_id, no .valis.json (CLI mode), no args.project_id.
    // The pre-fix behaviour silently fell through to an org-wide search; the
    // post-fix behaviour returns an empty result with a structured error so the
    // agent knows to ask the user which project to use.
    const overrideWithoutProject = { ...serverOverride, project_id: undefined as unknown as string };
    const result = await handleSearch({ query: 'database' }, overrideWithoutProject);
    expect(result.error).toBe('project_scope_required');
    expect(result.results).toHaveLength(0);
    expect(result.note).toMatch(/project/i);
  });

  it('uses args.project_id as a fallback when configOverride has no scope', async () => {
    // Plugin OAuth tokens often lack a project claim. The agent's system
    // reminder tells it to pass project_id explicitly in args; this test
    // locks in that the args value scopes the search rather than being
    // ignored as diagnostic-only metadata.
    const overrideWithoutProject = { ...serverOverride, project_id: undefined as unknown as string };
    const result = await handleSearch(
      { query: 'database', project_id: 'project-X' },
      overrideWithoutProject,
    );
    expect(result.error).toBeUndefined();
    // Mock hybridSearch returns a result regardless of filter; we just verify
    // the early-exit didn't fire.
    expect(result.results.length).toBeGreaterThan(0);
  });

  it('allows explicit all_projects opt-in without a project scope', async () => {
    const overrideWithoutProject = { ...serverOverride, project_id: undefined as unknown as string };
    const result = await handleSearch(
      { query: 'database', all_projects: true },
      overrideWithoutProject,
    );
    expect(result.error).toBeUndefined();
  });
});
