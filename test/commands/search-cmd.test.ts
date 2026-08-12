/**
 * gh#322 — `valis search --projects <a,b>` and the implicit `linked_projects`
 * read scope on the CLI path. Names, not UUIDs: the terminal is a human
 * surface, so an unresolvable name warns and the search still runs.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockLoadConfig = vi.fn();
const mockResolveConfig = vi.fn();
const mockHybridSearch = vi.fn();
const mockHybridSearchAllProjects = vi.fn();
const mockListMemberProjects = vi.fn();

vi.mock('../../src/config/store.js', () => ({
  loadConfig: (...a: unknown[]) => mockLoadConfig(...a),
}));
vi.mock('../../src/config/project.js', () => ({
  resolveConfig: (...a: unknown[]) => mockResolveConfig(...a),
}));
vi.mock('../../src/cloud/qdrant.js', async () => {
  const { mmrRerank } = await vi.importActual<typeof import('../../src/cloud/qdrant/search.js')>(
    '../../src/cloud/qdrant/search.js',
  );
  return {
    mmrRerank,
    getQdrantClient: vi.fn().mockReturnValue({}),
    hybridSearch: (...a: unknown[]) => mockHybridSearch(...a),
    hybridSearchAllProjects: (...a: unknown[]) => mockHybridSearchAllProjects(...a),
  };
});
vi.mock('../../src/cloud/supabase.js', () => ({
  getSupabaseClient: vi.fn().mockReturnValue({}),
  listMemberProjects: (...a: unknown[]) => mockListMemberProjects(...a),
}));
vi.mock('../../src/cloud/search-proxy.js', () => ({ proxySearch: vi.fn() }));
vi.mock('../../src/cloud/api-url.js', () => ({ isHostedMode: vi.fn().mockReturnValue(false) }));

import { searchCommand } from '../../src/commands/search-cmd.js';

const ACTIVE = 'a1b2c3d4-e5f6-4890-abcd-ef1234567890';
const OTHER = 'b2c3d4e5-f6a7-4901-bcde-f12345678901';

let err: string[];

beforeEach(() => {
  vi.clearAllMocks();
  err = [];
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void err.push(a.join(' ')));
  mockLoadConfig.mockResolvedValue({
    org_id: 'org-1',
    member_id: 'member-1',
    supabase_url: 'https://x.supabase.co',
    supabase_service_role_key: 'srk',
    qdrant_url: 'https://q',
    qdrant_api_key: 'qk',
  });
  mockResolveConfig.mockResolvedValue({
    global: null,
    project: { project_id: ACTIVE, project_name: 'frontend-app' },
  });
  mockListMemberProjects.mockResolvedValue([
    { id: ACTIVE, name: 'frontend-app', role: 'm', decision_count: 1 },
    { id: OTHER, name: 'backend-api', role: 'm', decision_count: 2 },
  ]);
  mockHybridSearch.mockResolvedValue([]);
  mockHybridSearchAllProjects.mockResolvedValue([]);
});

describe('valis search --projects (gh#322)', () => {
  it('narrows the search to the named projects', async () => {
    await searchCommand('q', { projects: 'backend-api' });
    expect(mockHybridSearch).toHaveBeenCalled();
    expect(mockHybridSearch.mock.calls[0][3].projectId).toBe(OTHER);
  });

  it('spans several named projects in one query', async () => {
    await searchCommand('q', { projects: 'frontend-app,backend-api' });
    expect(mockHybridSearchAllProjects).toHaveBeenCalled();
    expect(mockHybridSearchAllProjects.mock.calls[0][3]).toEqual([ACTIVE, OTHER]);
  });

  it('applies linked_projects when no flag is given', async () => {
    mockResolveConfig.mockResolvedValue({
      global: null,
      project: { project_id: ACTIVE, project_name: 'frontend-app', linked_projects: [OTHER] },
    });
    await searchCommand('q', {});
    expect(mockHybridSearchAllProjects.mock.calls[0][3]).toEqual([ACTIVE, OTHER]);
  });

  it('warns on stderr for an unresolvable name and still searches', async () => {
    await searchCommand('q', { projects: 'backend-api,ghost-project' });
    expect(err.join('\n')).toContain('ghost-project');
    expect(mockHybridSearch).toHaveBeenCalled();
  });
});
