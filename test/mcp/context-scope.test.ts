/**
 * 039/#94 — contract tests for the `scope` envelope + `scope_hint` on
 * `valis_context` responses (US1 + US2), covering BOTH transports:
 * hosted-proxy (isHostedMode → true, via proxySearch) and direct-Qdrant
 * (isHostedMode → false, via hybridSearch).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/config/store.js', () => ({
  loadConfig: vi.fn().mockResolvedValue({
    org_id: 'test-org-id',
    qdrant_url: 'https://test.qdrant.io',
    qdrant_api_key: 'test-key',
  }),
}));

vi.mock('../../src/config/project.js', () => ({
  resolveConfig: vi.fn().mockResolvedValue({ global: null, project: null }),
}));

vi.mock('../../src/cloud/qdrant.js', async () => {
  // Keep the REAL pure `mmrRerank` — the tool path now calls it as the
  // final-transform diversifier (diversifyBucket). It's side-effect-free, so
  // wiring the genuine implementation keeps these tests production-faithful.
  const { mmrRerank } = await vi.importActual<typeof import('../../src/cloud/qdrant/search.js')>(
    '../../src/cloud/qdrant/search.js',
  );
  return {
    mmrRerank,
    getQdrantClient: vi.fn().mockReturnValue({}),
    hybridSearch: vi.fn(),
    hybridSearchAllProjects: vi.fn(),
  };
});

vi.mock('../../src/cloud/supabase.js', () => ({
  getSupabaseClient: vi.fn().mockReturnValue({}),
  getSupabaseJwtClient: vi.fn().mockReturnValue({}),
  listMemberProjects: vi.fn().mockResolvedValue([
    { id: 'project-A', name: 'Alpha', role: 'project_member', decision_count: 3 },
    { id: 'project-B', name: 'Beta', role: 'project_member', decision_count: 1 },
    { id: 'project-C', name: 'Gamma', role: 'project_member', decision_count: 0 },
  ]),
  // finding #1 — cross-org target name resolution (project NOT in memberships).
  getProjectName: vi.fn().mockImplementation(async (_client: unknown, id: string) =>
    id === 'project-X' ? 'Cross-Org Xenon' : null,
  ),
}));

// finding #3 — stub the upstream suppression boundary so the real
// handleContext → attachScope → buildScopeHint wiring can be driven into the
// "empty results + suppressed>0" state. Default: pass-through, suppressed 0.
vi.mock('../../src/search/suppression.js', () => ({
  suppressResults: vi.fn((results: unknown[]) => ({
    visible: results,
    suppressed_count: 0,
  })),
}));

vi.mock('../../src/cloud/search-proxy.js', () => ({
  proxySearch: vi.fn(),
}));

vi.mock('../../src/lib/project-access.js', () => ({
  canReadProject: vi.fn().mockResolvedValue(true),
}));

vi.mock('../../src/cloud/supabase/audit.js', () => ({
  storeAuditEntry: vi.fn().mockResolvedValue({}),
}));

import { handleContext } from '../../src/mcp/tools/context.js';
import { hybridSearch } from '../../src/cloud/qdrant.js';
import { proxySearch } from '../../src/cloud/search-proxy.js';
import { isHostedMode } from '../../src/cloud/api-url.js';
import { suppressResults } from '../../src/search/suppression.js';
import type { ServerConfig } from '../../src/types.js';

vi.mock('../../src/cloud/api-url.js', () => ({
  isHostedMode: vi.fn(),
}));

const POPULATED = [
  {
    id: 'r1',
    score: 0.9,
    type: 'decision',
    summary: 'Chose PostgreSQL',
    detail: 'We chose PostgreSQL',
    author: 'olena',
    affects: ['database'],
    created_at: '2026-03-20T14:30:00Z',
  },
];

function buildServerConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    org_id: 'test-org-id',
    member_id: 'member-1',
    author_name: 'tester',
    role: 'member',
    auth_mode: 'jwt',
    supabase_url: 'https://test.supabase.co',
    supabase_service_role_key: 'test-srk',
    qdrant_url: 'https://test.qdrant.io',
    qdrant_api_key: 'test-key',
    api_key: 'tmm_test',
    member_api_key: 'tmm_test',
    project_id: 'project-A',
    ...overrides,
  } as ServerConfig;
}

beforeEach(() => {
  vi.clearAllMocks();
  // Re-establish the pass-through suppression after clearAllMocks wipes it.
  vi.mocked(suppressResults).mockImplementation((results) => ({
    visible: results,
    suppressed_count: 0,
  }));
});

describe('handleContext — scope envelope (US1)', () => {
  it('attaches scope on the hosted-proxy path', async () => {
    vi.mocked(isHostedMode).mockReturnValue(true);
    vi.mocked(proxySearch).mockResolvedValue({ results: POPULATED });
    const res = await handleContext({ task_description: 'build auth' }, buildServerConfig());
    expect(res.scope).toBeDefined();
    expect(res.scope!.active_project).toEqual({ id: 'project-A', name: 'Alpha' });
    expect(res.scope!.accessible_projects).toHaveLength(3);
    expect(res.scope!.queried_all_projects).toBe(false);
  });

  it('attaches scope on the direct-Qdrant path with identical shape', async () => {
    vi.mocked(isHostedMode).mockReturnValue(false);
    vi.mocked(hybridSearch).mockResolvedValue(POPULATED);
    const res = await handleContext({ task_description: 'build auth' }, buildServerConfig());
    expect(res.scope).toBeDefined();
    expect(res.scope!.active_project).toEqual({ id: 'project-A', name: 'Alpha' });
    expect(res.scope!.accessible_projects).toHaveLength(3);
    expect(res.scope!.queried_all_projects).toBe(false);
  });

  it('sets queried_all_projects: true on cross-project context (direct path)', async () => {
    vi.mocked(isHostedMode).mockReturnValue(false);
    const { hybridSearchAllProjects } = await import('../../src/cloud/qdrant.js');
    vi.mocked(hybridSearchAllProjects).mockResolvedValue(POPULATED);
    const res = await handleContext(
      { task_description: 'build auth', all_projects: true },
      buildServerConfig(),
    );
    expect(res.scope!.queried_all_projects).toBe(true);
    expect(res.scope!.accessible_projects).toHaveLength(3);
  });
});

describe('handleContext — scope_hint (US2)', () => {
  it('emits scope_hint on empty results with >1 accessible project (proxy path)', async () => {
    vi.mocked(isHostedMode).mockReturnValue(true);
    vi.mocked(proxySearch).mockResolvedValue({ results: [] });
    const res = await handleContext({ task_description: 'nothing matches' }, buildServerConfig());
    expect(res.scope_hint).toBeDefined();
    expect(res.scope_hint).toContain('all_projects');
  });

  it('emits scope_hint on empty results (direct path)', async () => {
    vi.mocked(isHostedMode).mockReturnValue(false);
    vi.mocked(hybridSearch).mockResolvedValue([]);
    const res = await handleContext({ task_description: 'nothing matches' }, buildServerConfig());
    expect(res.scope_hint).toBeDefined();
  });

  it('omits scope_hint when results are non-empty', async () => {
    vi.mocked(isHostedMode).mockReturnValue(false);
    vi.mocked(hybridSearch).mockResolvedValue(POPULATED);
    const res = await handleContext({ task_description: 'build auth' }, buildServerConfig());
    expect(res.scope_hint).toBeUndefined();
  });

  it('omits scope_hint when all_projects already spanned everything', async () => {
    vi.mocked(isHostedMode).mockReturnValue(false);
    const { hybridSearchAllProjects } = await import('../../src/cloud/qdrant.js');
    vi.mocked(hybridSearchAllProjects).mockResolvedValue([]);
    const res = await handleContext(
      { task_description: 'nothing', all_projects: true },
      buildServerConfig(),
    );
    expect(res.scope_hint).toBeUndefined();
  });

  it('omits scope_hint when results are empty but matches were suppressed (finding #3)', async () => {
    vi.mocked(isHostedMode).mockReturnValue(false);
    vi.mocked(hybridSearch).mockResolvedValue(POPULATED);
    // Drive into empty-buckets + suppressed>0 via the real attachScope path.
    vi.mocked(suppressResults).mockReturnValueOnce({ visible: [], suppressed_count: 4 });
    const res = await handleContext({ task_description: 'build auth' }, buildServerConfig());
    expect(res.decisions).toHaveLength(0);
    expect(res.suppressed_count).toBe(4);
    expect(res.scope_hint).toBeUndefined();
  });
});

describe('handleContext — all_projects with no resolvable project scope (finding #2)', () => {
  it('emits a scope envelope with active_project: null on the direct path', async () => {
    vi.mocked(isHostedMode).mockReturnValue(false);
    const { hybridSearchAllProjects } = await import('../../src/cloud/qdrant.js');
    vi.mocked(hybridSearchAllProjects).mockResolvedValue(POPULATED);
    const overrideNoProject = buildServerConfig({ project_id: undefined as unknown as string });
    const res = await handleContext(
      { task_description: 'build auth', all_projects: true },
      overrideNoProject,
    );
    expect(res.error).toBeUndefined();
    expect(res.scope).toBeDefined();
    expect(res.scope!.active_project).toBeNull();
    expect(res.scope!.queried_all_projects).toBe(true);
    expect(res.scope!.accessible_projects).toHaveLength(3);
  });

  it('emits a scope envelope with active_project: null on the hosted-proxy path', async () => {
    vi.mocked(isHostedMode).mockReturnValue(true);
    vi.mocked(proxySearch).mockResolvedValue({ results: POPULATED });
    const overrideNoProject = buildServerConfig({ project_id: undefined as unknown as string });
    const res = await handleContext(
      { task_description: 'build auth', all_projects: true },
      overrideNoProject,
    );
    expect(res.scope).toBeDefined();
    expect(res.scope!.active_project).toBeNull();
    expect(res.scope!.queried_all_projects).toBe(true);
    expect(res.scope!.accessible_projects).toHaveLength(3);
  });
});

describe('handleContext — cross-org target name (finding #1)', () => {
  it('names a granted target_project_id absent from memberships on the proxy path', async () => {
    vi.mocked(isHostedMode).mockReturnValue(true);
    vi.mocked(proxySearch).mockResolvedValue({ results: POPULATED });
    const res = await handleContext(
      { task_description: 'build auth', target_project_id: 'project-X' },
      buildServerConfig(),
    );
    expect(res.scope!.active_project).not.toBeNull();
    expect(res.scope!.active_project!.id).toBe('project-X');
    expect(res.scope!.active_project!.name).toBe('Cross-Org Xenon');
    expect(res.scope!.accessible_projects).toContainEqual({
      id: 'project-X',
      name: 'Cross-Org Xenon',
    });
  });
});
