/**
 * 040/#226 — contract tests for the `proposed_pending` block on `valis_context`
 * (US1 + omission + isolation). Mirrors the search test. Asserts coexistence
 * with the 039 `scope` envelope (FR-008) and omission on offline / all_projects
 * / cross-org paths (FR-006).
 *
 * Direct-Qdrant mode (isHostedMode → false) with a service-role server override.
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
  const { mmrRerank } = await vi.importActual<typeof import('../../src/cloud/qdrant/search.js')>(
    '../../src/cloud/qdrant/search.js',
  );
  const rows = [
    {
      id: 'ctx-1',
      score: 0.95,
      type: 'decision',
      summary: 'Chose PostgreSQL',
      detail: 'We chose PostgreSQL for user data',
      author: 'olena',
      affects: ['database'],
      created_at: '2026-03-20T14:30:00Z',
      status: 'active',
      confidence: 0.8,
      pinned: false,
      depends_on: [],
    },
  ];
  return {
    getQdrantClient: vi.fn().mockReturnValue({}),
    hybridSearch: vi.fn().mockResolvedValue(rows),
    hybridSearchAllProjects: vi.fn().mockResolvedValue(rows),
    mmrRerank,
  };
});

vi.mock('../../src/billing/usage.js', () => ({
  checkUsageBeforeSearch: vi.fn().mockResolvedValue({ allowed: true }),
  incrementUsage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/cloud/supabase.js', () => {
  const draftsByProject: Record<string, number> = {
    'project-A': 7,
    'project-B': 0,
    'project-C': 3,
  };
  function mockCountClient() {
    function builder() {
      const state: { projectId?: string; isDecisionBucket: boolean; typeEq?: string } = {
        isDecisionBucket: false,
      };
      const chain: Record<string, unknown> = {};
      const ret = () => chain;
      chain.select = () => ret();
      chain.eq = (col: string, val: unknown) => {
        if (col === 'project_id') state.projectId = val as string;
        if (col === 'type') state.typeEq = val as string;
        return ret();
      };
      chain.or = () => ret();
      chain.in = () => {
        state.isDecisionBucket = true;
        return ret();
      };
      chain.order = () => ret();
      chain.limit = (n: number) => {
        const total = draftsByProject[state.projectId ?? ''] ?? 0;
        const rows = Array.from({ length: Math.min(n, total) }, (_v, i) => ({
          id: `${state.projectId}-draft-${i}`,
          type: 'decision',
          summary: `draft ${i}`,
        }));
        return Promise.resolve({ data: rows, error: null, count: null });
      };
      chain.then = (resolve: (v: unknown) => void) => {
        const total = draftsByProject[state.projectId ?? ''] ?? 0;
        let count = total;
        if (state.typeEq && state.typeEq !== 'decision') count = 0;
        resolve({ count, data: null, error: null });
      };
      return chain;
    }
    return { from: vi.fn(() => builder()) };
  }
  return {
    getSupabaseClient: vi.fn(() => mockCountClient()),
    getSupabaseJwtClient: vi.fn(() => mockCountClient()),
    getDecisionsByIds: vi.fn().mockResolvedValue([]),
    listMemberProjects: vi.fn().mockResolvedValue([
      { id: 'project-A', name: 'Alpha', role: 'project_member', decision_count: 3 },
      { id: 'project-B', name: 'Beta', role: 'project_member', decision_count: 1 },
      { id: 'project-C', name: 'Gamma', role: 'project_member', decision_count: 0 },
    ]),
  };
});

vi.mock('../../src/lib/project-access.js', () => ({
  canReadProject: vi.fn().mockResolvedValue(true),
}));

vi.mock('../../src/cloud/supabase/audit.js', () => ({
  storeAuditEntry: vi.fn().mockResolvedValue({}),
}));

vi.mock('../../src/cloud/api-url.js', () => ({
  isHostedMode: vi.fn().mockReturnValue(false),
}));

import { handleContext } from '../../src/mcp/tools/context.js';
import { hybridSearch } from '../../src/cloud/qdrant.js';

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
  vi.mocked(hybridSearch).mockResolvedValue([
    {
      id: 'ctx-1',
      score: 0.95,
      type: 'decision',
      summary: 'Chose PostgreSQL',
      detail: 'We chose PostgreSQL for user data',
      author: 'olena',
      affects: ['database'],
      created_at: '2026-03-20T14:30:00Z',
      status: 'active',
      confidence: 0.8,
      pinned: false,
      depends_on: [],
    },
  ] as never);
});

describe('handleContext — proposed_pending (US1)', () => {
  it('attaches count + triage_url for a healthy single-project call', async () => {
    const res = await handleContext({ task_description: 'work on auth' }, serverOverride);
    expect(res.proposed_pending).toBeDefined();
    expect(res.proposed_pending!.count).toBe(7);
    expect(res.proposed_pending!.triage_url).toMatch(/\/projects\/project-A\/decisions\/triage$/);
  });

  it('coexists with the 039 scope envelope (FR-008)', async () => {
    const res = await handleContext({ task_description: 'work' }, serverOverride);
    expect(res.scope).toBeDefined();
    expect(res.scope!.active_project.id).toBe('project-A');
    expect(res.proposed_pending).toBeDefined();
  });

  it('emits count: 0 with empty top_3 on a healthy zero-draft project', async () => {
    const res = await handleContext(
      { task_description: 'work' },
      { ...serverOverride, project_id: 'project-B' },
    );
    expect(res.proposed_pending).toBeDefined();
    expect(res.proposed_pending!.count).toBe(0);
    expect(res.proposed_pending!.top_3).toEqual([]);
  });
});

describe('handleContext — proposed_pending omission rules (FR-006)', () => {
  it('OMITS the block on a cross-project (all_projects) call', async () => {
    const res = await handleContext(
      { task_description: 'work', all_projects: true },
      serverOverride,
    );
    expect(res.proposed_pending).toBeUndefined();
  });

  it('OMITS the block on a cross-org target_project_id read', async () => {
    const res = await handleContext(
      { task_description: 'work', target_project_id: 'project-C' },
      serverOverride,
    );
    expect(res.proposed_pending).toBeUndefined();
  });

  it('OMITS the block on the backend-error path', async () => {
    vi.mocked(hybridSearch).mockRejectedValueOnce(new Error('boom'));
    const res = await handleContext({ task_description: 'work' }, serverOverride);
    expect(res.proposed_pending).toBeUndefined();
  });
});

describe('handleContext — proposed_pending isolation (FR-009)', () => {
  it("reflects only the active project's draft count", async () => {
    const a = await handleContext({ task_description: 'x' }, { ...serverOverride, project_id: 'project-A' });
    const c = await handleContext({ task_description: 'x' }, { ...serverOverride, project_id: 'project-C' });
    expect(a.proposed_pending!.count).toBe(7);
    expect(c.proposed_pending!.count).toBe(3);
  });
});
