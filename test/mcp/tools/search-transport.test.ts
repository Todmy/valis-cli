import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockHybridSearch = vi.fn();
const mockHybridSearchAllProjects = vi.fn();
const mockListMemberProjects = vi.fn();
const mockProxySearch = vi.fn();
const mockIsHostedMode = vi.fn();

vi.mock('../../../src/cloud/qdrant.js', () => ({
  getQdrantClient: vi.fn().mockReturnValue({}),
  hybridSearch: (...args: unknown[]) => mockHybridSearch(...args),
  hybridSearchAllProjects: (...args: unknown[]) => mockHybridSearchAllProjects(...args),
}));

vi.mock('../../../src/cloud/supabase.js', () => ({
  getSupabaseClient: vi.fn().mockReturnValue({}),
  getSupabaseJwtClient: vi.fn().mockReturnValue({}),
  listMemberProjects: (...args: unknown[]) => mockListMemberProjects(...args),
}));

vi.mock('../../../src/cloud/search-proxy.js', () => ({
  proxySearch: (...args: unknown[]) => mockProxySearch(...args),
}));

vi.mock('../../../src/cloud/api-url.js', () => ({
  isHostedMode: (...args: unknown[]) => mockIsHostedMode(...args),
}));

import {
  chooseSearchTransport,
  createDirectTransport,
  createProxyTransport,
} from '../../../src/mcp/tools/search-transport.js';
import type { ValisConfig, SearchResult } from '../../../src/types.js';

const baseConfig: ValisConfig = {
  org_id: 'org-1',
  org_name: 'Test',
  api_key: 'tm_x',
  invite_code: 'inv',
  author_name: 'Dmytro',
  supabase_url: 'https://supabase.example',
  supabase_service_role_key: 'srk',
  qdrant_url: 'https://qdrant.example',
  qdrant_api_key: 'qk',
  configured_ides: [],
  created_at: '2026-01-01',
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('chooseSearchTransport', () => {
  it('selects proxy transport when auth_mode=jwt and hosted', () => {
    mockIsHostedMode.mockReturnValueOnce(true);
    mockProxySearch.mockResolvedValueOnce([]);
    const transport = chooseSearchTransport({ ...baseConfig, auth_mode: 'jwt' });

    return transport.search('q', {}).then(() => {
      expect(mockProxySearch).toHaveBeenCalledTimes(1);
      expect(mockHybridSearch).not.toHaveBeenCalled();
    });
  });

  it('selects direct transport when not hosted', () => {
    mockIsHostedMode.mockReturnValueOnce(false);
    mockHybridSearch.mockResolvedValueOnce([]);
    const transport = chooseSearchTransport({ ...baseConfig, auth_mode: 'legacy' });

    return transport.search('q', {}).then(() => {
      expect(mockHybridSearch).toHaveBeenCalledTimes(1);
      expect(mockProxySearch).not.toHaveBeenCalled();
    });
  });

  it('selects direct transport for legacy auth even with hosted url', () => {
    mockIsHostedMode.mockReturnValueOnce(true);
    mockHybridSearch.mockResolvedValueOnce([]);
    const transport = chooseSearchTransport({ ...baseConfig }); // no auth_mode = legacy

    return transport.search('q', {}).then(() => {
      expect(mockHybridSearch).toHaveBeenCalledTimes(1);
      expect(mockProxySearch).not.toHaveBeenCalled();
    });
  });
});

describe('proxy transport', () => {
  it('passes options through to proxySearch and returns results unchanged', async () => {
    const fixture: SearchResult[] = [
      { id: 'a', score: 0.9, type: 'decision', summary: 's', detail: 'd', status_label: 'active', status: 'active' } as SearchResult,
    ];
    mockProxySearch.mockResolvedValueOnce(fixture);

    const transport = createProxyTransport({
      ...baseConfig,
      auth_mode: 'jwt',
      member_id: 'mem-1',
    });
    const results = await transport.search('q', {
      type: 'decision',
      projectId: 'proj-1',
      all_projects: true,
    });

    expect(results).toEqual(fixture);
    expect(mockProxySearch).toHaveBeenCalledWith(
      expect.objectContaining({ org_id: 'org-1' }),
      'q',
      expect.objectContaining({
        type: 'decision',
        limit: 50,
        project_id: 'proj-1',
        all_projects: true,
        member_id: 'mem-1',
      }),
    );
  });
});

describe('direct transport', () => {
  it('default-scope: calls hybridSearch with projectId', async () => {
    const fixture: SearchResult[] = [
      { id: 'a', score: 0.9, type: 'decision', summary: 's', detail: 'd' } as SearchResult,
    ];
    mockHybridSearch.mockResolvedValueOnce(fixture);

    const transport = createDirectTransport(baseConfig);
    const results = await transport.search('q', { projectId: 'proj-x' });

    expect(mockHybridSearch).toHaveBeenCalledWith(
      expect.anything(),
      'org-1',
      'q',
      expect.objectContaining({ projectId: 'proj-x', limit: 50 }),
    );
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('active'); // default
    expect(results[0].status_label).toBe('active');
  });

  it('all_projects: calls hybridSearchAllProjects with member project ids', async () => {
    const fixture: SearchResult[] = [
      { id: 'a', score: 0.9, type: 'decision', summary: 's', detail: 'd', project_id: 'p1' } as SearchResult,
    ];
    mockListMemberProjects.mockResolvedValueOnce([
      { id: 'p1', name: 'Project One' },
      { id: 'p2', name: 'Project Two' },
    ]);
    mockHybridSearchAllProjects.mockResolvedValueOnce(fixture);

    const transport = createDirectTransport({ ...baseConfig, member_id: 'mem-1' });
    const results = await transport.search('q', { all_projects: true });

    expect(mockHybridSearchAllProjects).toHaveBeenCalledWith(
      expect.anything(),
      'org-1',
      'q',
      ['p1', 'p2'],
      expect.objectContaining({ limit: 50 }),
    );
    expect(results[0].project_name).toBe('Project One');
  });

  it('all_projects with no member_id falls back to org-wide hybridSearch', async () => {
    mockHybridSearch.mockResolvedValueOnce([]);

    const transport = createDirectTransport({ ...baseConfig }); // no member_id
    await transport.search('q', { all_projects: true });

    expect(mockHybridSearch).toHaveBeenCalledTimes(1);
    expect(mockHybridSearchAllProjects).not.toHaveBeenCalled();
  });

  it('all_projects: project list failure falls back to org-wide search (fail-closed)', async () => {
    mockListMemberProjects.mockRejectedValueOnce(new Error('access denied'));
    mockHybridSearch.mockResolvedValueOnce([]);

    const transport = createDirectTransport({ ...baseConfig, member_id: 'mem-1' });
    await transport.search('q', { all_projects: true });

    expect(mockHybridSearch).toHaveBeenCalledTimes(1);
    expect(mockHybridSearchAllProjects).not.toHaveBeenCalled();
  });

  it('enriches with replaced_by reverse lookup', async () => {
    mockHybridSearch.mockResolvedValueOnce([
      { id: 'new', score: 0.9, type: 'decision', summary: 's', detail: 'd', replaces: 'old' },
      { id: 'old', score: 0.5, type: 'decision', summary: 's2', detail: 'd2' },
    ] as SearchResult[]);

    const transport = createDirectTransport(baseConfig);
    const results = await transport.search('q', {});

    const oldResult = results.find((r) => r.id === 'old');
    expect(oldResult?.replaced_by).toBe('new');
  });

  it('throws when underlying hybridSearch throws (orchestrator translates to offline)', async () => {
    mockHybridSearch.mockRejectedValueOnce(new Error('Qdrant timeout'));
    const transport = createDirectTransport(baseConfig);
    await expect(transport.search('q', {})).rejects.toThrow('Qdrant timeout');
  });
});

describe('direct transport — status-based ranking (through the port)', () => {
  it('ranks active above proposed above deprecated above superseded at equal score', async () => {
    mockHybridSearch.mockResolvedValueOnce([
      { id: 'a', score: 0.5, status: 'deprecated' } as SearchResult,
      { id: 'b', score: 0.5, status: 'active' } as SearchResult,
      { id: 'c', score: 0.5, status: 'superseded' } as SearchResult,
      { id: 'd', score: 0.5, status: 'proposed' } as SearchResult,
    ]);
    const transport = createDirectTransport(baseConfig);
    const out = await transport.search('q', {});
    expect(out.map((r) => r.id)).toEqual(['b', 'd', 'a', 'c']);
  });

  it('preserves score-driven order beyond a 0.01 tolerance', async () => {
    mockHybridSearch.mockResolvedValueOnce([
      { id: 'lo', score: 0.5, status: 'active' } as SearchResult,
      { id: 'hi', score: 0.9, status: 'deprecated' } as SearchResult,
    ]);
    const transport = createDirectTransport(baseConfig);
    const out = await transport.search('q', {});
    expect(out[0].id).toBe('hi'); // higher score wins despite worse status
  });
});
