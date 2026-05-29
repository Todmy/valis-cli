/**
 * 039/#94 — contract tests for the `scope` envelope + `scope_hint` on
 * `valis_search` responses (US1 + US2).
 *
 * Transport runs in direct-Qdrant mode (isHostedMode → false) with a
 * service-role server override so `resolveAccessibleProjects` calls
 * `listMemberProjects` and gets the 3-project fixture.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/config/store.js', () => ({
  loadConfig: vi.fn().mockResolvedValue({
    org_id: 'test-org-id',
    qdrant_url: 'https://test.qdrant.io',
    qdrant_api_key: 'test-key',
  }),
}));

// CLI stdio path reads .valis.json via resolveConfig — mock it to null so
// args.project_id is the resolved scope (no real worktree project bleeds in).
vi.mock('../../src/config/project.js', () => ({
  resolveConfig: vi.fn().mockResolvedValue({ global: null, project: null }),
}));

vi.mock('../../src/cloud/qdrant.js', async () => {
  // Keep the REAL pure `mmrRerank` — the tool path now calls it as the
  // final-transform diversifier. It's side-effect-free, so wiring the genuine
  // implementation keeps these tests production-faithful.
  const { mmrRerank } = await vi.importActual<typeof import('../../src/cloud/qdrant/search.js')>(
    '../../src/cloud/qdrant/search.js',
  );
  const populated = [
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
  ];
  return {
    mmrRerank,
    getQdrantClient: vi.fn().mockReturnValue({}),
    hybridSearch: vi.fn().mockResolvedValue(populated),
    hybridSearchAllProjects: vi.fn().mockResolvedValue(populated),
  };
});

const POPULATED = [
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
];

vi.mock('../../src/billing/usage.js', () => ({
  checkUsageBeforeSearch: vi.fn().mockResolvedValue({ allowed: true }),
  incrementUsage: vi.fn().mockResolvedValue(undefined),
}));

// IMPORTANT (finding #5): the membership fixture intentionally EXCLUDES the
// cross-org target (`project-X`). A cross-org read targets a project the
// caller is NOT a member of (feature 033 public-KB), so it can never appear in
// `listMemberProjects`. If the fixture included it, `active_project.name`
// would resolve from the membership list by accident and the test would pass
// for the wrong reason — masking finding #1 (the name must be fetched
// separately for cross-org targets). `getProjectName` is the real lookup the
// fix relies on; mock it to return the cross-org project's display name.
vi.mock('../../src/cloud/supabase.js', () => ({
  getSupabaseClient: vi.fn().mockReturnValue({}),
  getSupabaseJwtClient: vi.fn().mockReturnValue({}),
  getDecisionsByIds: vi.fn().mockResolvedValue([]),
  listMemberProjects: vi.fn().mockResolvedValue([
    { id: 'project-A', name: 'Alpha', role: 'project_member', decision_count: 3 },
    { id: 'project-B', name: 'Beta', role: 'project_member', decision_count: 1 },
  ]),
  getProjectName: vi.fn().mockImplementation(async (_client: unknown, id: string) =>
    id === 'project-X' ? 'Cross-Org Xenon' : null,
  ),
}));

vi.mock('../../src/lib/project-access.js', () => ({
  canReadProject: vi.fn().mockResolvedValue(true),
}));

vi.mock('../../src/cloud/supabase/audit.js', () => ({
  storeAuditEntry: vi.fn().mockResolvedValue({}),
}));

vi.mock('../../src/cloud/api-url.js', () => ({
  isHostedMode: vi.fn().mockReturnValue(false),
}));

// finding #3 — drive handleSearch into the "empty visible + suppressed>0"
// state deterministically. We stub the upstream suppression (NOT the symbol
// under test) so the REAL handleSearch → assembleResponse → buildScopeHint
// wiring runs against a known suppressed_count. By default it passes results
// through unchanged so the other tests behave normally.
vi.mock('../../src/search/suppression.js', () => ({
  suppressResults: vi.fn((results: unknown[]) => ({
    visible: results,
    suppressed_count: 0,
  })),
}));

import { handleSearch } from '../../src/mcp/tools/search.js';
import { hybridSearch } from '../../src/cloud/qdrant.js';
import { suppressResults } from '../../src/search/suppression.js';

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

beforeEach(() => {
  vi.mocked(hybridSearch).mockResolvedValue(POPULATED);
});

describe('handleSearch — scope envelope (US1)', () => {
  it('attaches scope naming the active project + accessible projects on a populated result', async () => {
    const res = await handleSearch({ query: 'database' }, serverOverride);
    expect(res.scope).toBeDefined();
    expect(res.scope!.active_project).toEqual({ id: 'project-A', name: 'Alpha' });
    expect(res.scope!.accessible_projects).toEqual([
      { id: 'project-A', name: 'Alpha' },
      { id: 'project-B', name: 'Beta' },
    ]);
    expect(res.scope!.queried_all_projects).toBe(false);
  });

  it('sets queried_all_projects: true when all_projects is passed', async () => {
    const res = await handleSearch(
      { query: 'database', all_projects: true },
      serverOverride,
    );
    expect(res.scope!.queried_all_projects).toBe(true);
  });

  it('emits a scope envelope on the all_projects path with no resolvable project scope (finding #2)', async () => {
    // all_projects: true + no project_id from any source. The previous code
    // set scope = undefined and assembleResponse omitted both keys, breaking
    // the "scope present on every successful response" contract. Now the
    // envelope is emitted with active_project: null + the accessible list.
    const overrideNoProject = {
      ...serverOverride,
      project_id: undefined as unknown as string,
    };
    const res = await handleSearch(
      { query: 'database', all_projects: true },
      overrideNoProject,
    );
    expect(res.error).toBeUndefined();
    expect(res.scope).toBeDefined();
    expect(res.scope!.active_project).toBeNull();
    expect(res.scope!.queried_all_projects).toBe(true);
    expect(res.scope!.accessible_projects).toEqual([
      { id: 'project-A', name: 'Alpha' },
      { id: 'project-B', name: 'Beta' },
    ]);
  });

  it('names target_project_id as active_project on a granted cross-org read even though it is NOT in the caller memberships (FR-004, finding #1)', async () => {
    // project-X is deliberately absent from the membership fixture — a
    // cross-org public-KB read targets a project the caller is not a member
    // of. The name must be resolved via getProjectName, not the membership
    // list. This is the exact case the old fixture (which included the
    // target) silently masked.
    const res = await handleSearch(
      { query: 'database', target_project_id: 'project-X' },
      serverOverride,
    );
    expect(res.scope!.active_project).not.toBeNull();
    expect(res.scope!.active_project!.id).toBe('project-X');
    // The crux of finding #1: name resolves despite the target being absent
    // from listMemberProjects.
    expect(res.scope!.active_project!.name).toBe('Cross-Org Xenon');
    // And the queried project appears in accessible_projects so the agent can
    // name what it actually searched.
    expect(res.scope!.accessible_projects).toContainEqual({
      id: 'project-X',
      name: 'Cross-Org Xenon',
    });
  });

  it('degrades to [active_project] in CLI stdio mode (no member creds)', async () => {
    // No configOverride → CLI stdio. No member_id → membership lookup skipped.
    // Active project comes from args.project_id fallback.
    const res = await handleSearch({ query: 'database', project_id: 'project-X' });
    expect(res.scope).toBeDefined();
    expect(res.scope!.active_project).not.toBeNull();
    expect(res.scope!.active_project!.id).toBe('project-X');
    expect(res.scope!.accessible_projects).toEqual([{ id: 'project-X', name: '' }]);
  });

  it('omits scope on the project_scope_required fail-closed path', async () => {
    const overrideNoProject = { ...serverOverride, project_id: undefined as unknown as string };
    const res = await handleSearch({ query: 'database' }, overrideNoProject);
    expect(res.error).toBe('project_scope_required');
    expect(res.scope).toBeUndefined();
  });
});

describe('handleSearch — scope_hint (US2)', () => {
  it('emits scope_hint on empty results with >1 accessible project', async () => {
    vi.mocked(hybridSearch).mockResolvedValueOnce([]);
    const res = await handleSearch({ query: 'nothing matches' }, serverOverride);
    expect(res.results).toHaveLength(0);
    expect(res.scope_hint).toBeDefined();
    expect(res.scope_hint).toContain('all_projects');
  });

  it('omits scope_hint when results are non-empty', async () => {
    const res = await handleSearch({ query: 'database' }, serverOverride);
    expect(res.results.length).toBeGreaterThan(0);
    expect(res.scope_hint).toBeUndefined();
  });

  it('omits scope_hint when all_projects already spanned everything', async () => {
    vi.mocked(hybridSearch).mockResolvedValueOnce([]);
    const res = await handleSearch(
      { query: 'nothing', all_projects: true },
      serverOverride,
    );
    expect(res.scope_hint).toBeUndefined();
  });

  it('omits scope_hint for a single-project member (CLI stdio fallback)', async () => {
    vi.mocked(hybridSearch).mockResolvedValueOnce([]);
    const res = await handleSearch({ query: 'nothing', project_id: 'project-X' });
    expect(res.scope!.accessible_projects).toHaveLength(1);
    expect(res.scope_hint).toBeUndefined();
  });

  it('omits scope_hint when visible results are empty but matches were suppressed (finding #3)', async () => {
    // The project HAS matching decisions — they all fell below the within-area
    // suppression threshold (visible empty, suppressed_count > 0). Concluding
    // "nothing was decided" would be a lie, so the cross-project-retry advisory
    // must NOT fire. The real handleSearch → assembleResponse → buildScopeHint
    // path runs; only the upstream suppression boundary is stubbed to reach the
    // empty-visible-with-suppressed state.
    vi.mocked(hybridSearch).mockResolvedValueOnce(POPULATED);
    vi.mocked(suppressResults).mockReturnValueOnce({ visible: [], suppressed_count: 3 });
    const res = await handleSearch({ query: 'database' }, serverOverride);
    expect(res.results).toHaveLength(0);
    expect(res.suppressed_count).toBe(3);
    expect(res.scope_hint).toBeUndefined();
  });

  it('emits scope_hint when results are empty AND nothing was suppressed (finding #3 inverse)', async () => {
    // Genuine empty: no visible, no suppressed. The advisory SHOULD fire so the
    // agent retries across projects before concluding nothing was decided.
    vi.mocked(hybridSearch).mockResolvedValueOnce([]);
    vi.mocked(suppressResults).mockReturnValueOnce({ visible: [], suppressed_count: 0 });
    const res = await handleSearch({ query: 'nothing' }, serverOverride);
    expect(res.results).toHaveLength(0);
    expect(res.scope_hint).toBeDefined();
  });
});
