import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/config/store.js', () => ({
  loadConfig: vi.fn().mockResolvedValue({
    org_id: 'test-org-id',
    qdrant_url: 'https://test.qdrant.io',
    qdrant_api_key: 'test-key',
  }),
}));

vi.mock('../../../src/cloud/qdrant.js', () => ({
  getQdrantClient: vi.fn().mockReturnValue({}),
  hybridSearch: vi.fn().mockResolvedValue([
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
    {
      id: 'r2',
      score: 0.8,
      type: 'constraint',
      summary: 'Must support Safari 15+',
      detail: 'Client requires Safari 15+ support',
      author: 'andriy',
      affects: ['frontend'],
      created_at: '2026-03-19T10:00:00Z',
    },
  ]),
  hybridSearchAllProjects: vi.fn().mockResolvedValue([
    {
      id: 'r1',
      score: 0.9,
      type: 'decision',
      summary: 'Chose PostgreSQL',
      detail: 'We chose PostgreSQL',
      author: 'olena',
      affects: ['database'],
      created_at: '2026-03-20T14:30:00Z',
      project_id: 'proj-a',
    },
  ]),
}));

vi.mock('../../../src/cloud/supabase.js', () => ({
  getSupabaseClient: vi.fn().mockReturnValue({}),
  getSupabaseJwtClient: vi.fn().mockReturnValue({}),
  listMemberProjects: vi.fn(),
}));

vi.mock('../../../src/cloud/search-proxy.js', () => ({
  proxySearch: vi.fn(),
}));

import { handleContext } from '../../../src/mcp/tools/context.js';
import { hybridSearch, hybridSearchAllProjects } from '../../../src/cloud/qdrant.js';
import { listMemberProjects } from '../../../src/cloud/supabase.js';
import type { ServerConfig } from '../../../src/types.js';

/**
 * Build a server-mode ServerConfig (HTTP MCP transport). The presence of
 * supabase_service_role_key + matching this fluent pattern is what /api/mcp
 * passes via configOverride.
 */
function buildServerConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    org_id: 'test-org-id',
    member_id: 'test-member-id',
    author_name: 'tester',
    role: 'member',
    auth_mode: 'jwt',
    supabase_url: 'https://test.supabase.co',
    supabase_service_role_key: 'test-srk',
    qdrant_url: 'https://test.qdrant.io',
    qdrant_api_key: 'test-key',
    api_key: 'tmm_test',
    member_api_key: 'tmm_test',
    ...overrides,
  } as ServerConfig;
}

describe('handleContext', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(hybridSearch).mockResolvedValue([
      {
        id: 'r1',
        score: 0.9,
        type: 'decision',
        summary: 'Chose PostgreSQL',
        detail: 'We chose PostgreSQL',
        author: 'olena',
        affects: ['database'],
        created_at: '2026-03-20T14:30:00Z',
      } as never,
      {
        id: 'r2',
        score: 0.8,
        type: 'constraint',
        summary: 'Must support Safari 15+',
        detail: 'Client requires Safari 15+ support',
        author: 'andriy',
        affects: ['frontend'],
        created_at: '2026-03-19T10:00:00Z',
      } as never,
    ]);
    vi.mocked(hybridSearchAllProjects).mockResolvedValue([
      {
        id: 'r1',
        score: 0.9,
        type: 'decision',
        summary: 'Chose PostgreSQL',
        detail: 'We chose PostgreSQL',
        author: 'olena',
        affects: ['database'],
        created_at: '2026-03-20T14:30:00Z',
        project_id: 'proj-a',
      } as never,
    ]);
  });

  it('returns grouped results', async () => {
    const result = await handleContext({
      task_description: 'Implement user authentication',
    });

    expect(result.decisions).toHaveLength(1);
    expect(result.constraints).toHaveLength(1);
    expect(result.total_in_brain).toBe(2);
  });

  it('includes orientation note on first call', async () => {
    const result = await handleContext({
      task_description: 'Setup database migrations',
      files: ['src/db/migrations.ts'],
    });

    expect(result).toHaveProperty('total_in_brain');
  });

  // 019/US1 (R-006 test 1, T005): when called server-side with no project_id,
  // handleContext must use the cross-project membership fallback (the same
  // path handleSearch already uses). The proof is that hybridSearchAllProjects
  // was called with the member's project list — not the org-wide hybridSearch.
  it('returns same project set as handleSearch when called with no project_id', async () => {
    vi.mocked(listMemberProjects).mockResolvedValueOnce([
      { id: 'proj-a' } as never,
      { id: 'proj-b' } as never,
    ]);

    const config = buildServerConfig();
    const result = await handleContext({ task_description: 'auth' }, config);

    expect(hybridSearchAllProjects).toHaveBeenCalledTimes(1);
    expect(hybridSearchAllProjects).toHaveBeenCalledWith(
      expect.anything(),
      'test-org-id',
      'auth',
      ['proj-a', 'proj-b'],
      expect.any(Object),
    );
    expect(result.total_in_brain).toBeGreaterThan(0);
    expect(result.offline).toBeUndefined();
  });

  // 019/US1 (R-006 test 2, T005): on HTTP transport (configOverride present),
  // the response NEVER includes offline:true — even on backend failure.
  it('never returns offline:true on HTTP transport', async () => {
    vi.mocked(listMemberProjects).mockResolvedValueOnce([
      { id: 'proj-a' } as never,
    ]);
    vi.mocked(hybridSearchAllProjects).mockRejectedValueOnce(new Error('qdrant error'));

    const config = buildServerConfig();
    const result = await handleContext({ task_description: 'auth' }, config);

    expect(result.offline).toBeUndefined();
    expect(result.infrastructure_error).toBe(true);
  });

  // 019/US1 (R-006 test 3, T007): when caller has zero accessible projects,
  // emit no_accessible_projects:true with empty arrays — explicit "no data"
  // signal distinct from infrastructure failure.
  it('returns no_accessible_projects indicator when caller has zero projects', async () => {
    vi.mocked(listMemberProjects).mockResolvedValueOnce([]);

    const config = buildServerConfig();
    const result = await handleContext({ task_description: 'auth' }, config);

    expect(result.decisions).toEqual([]);
    expect(result.constraints).toEqual([]);
    expect(result.patterns).toEqual([]);
    expect(result.lessons).toEqual([]);
    expect(result.total_in_brain).toBe(0);
    expect(result.no_accessible_projects).toBe(true);
    expect(result.offline).toBeUndefined();
    expect(result.infrastructure_error).toBeUndefined();
    expect(result.backend_unavailable).toBeUndefined();
  });

  // 019/US1 (T068 — analyze C1 patch): infrastructure failure (search backend
  // unreachable) is distinct from `no_accessible_projects` and from `offline`.
  // Emits `infrastructure_error: true` so operators have an actionable signal.
  it('returns infrastructure_error indicator when search backend is unreachable', async () => {
    vi.mocked(listMemberProjects).mockResolvedValueOnce([
      { id: 'proj-a' } as never,
    ]);
    vi.mocked(hybridSearchAllProjects).mockRejectedValueOnce(
      new Error('connect ECONNREFUSED 127.0.0.1:6333'),
    );

    const config = buildServerConfig();
    const result = await handleContext({ task_description: 'auth' }, config);

    expect(result.decisions).toEqual([]);
    expect(result.constraints).toEqual([]);
    expect(result.patterns).toEqual([]);
    expect(result.lessons).toEqual([]);
    expect(result.total_in_brain).toBe(0);
    expect(result.infrastructure_error).toBe(true);
    expect(result.offline).toBeUndefined();
    expect(result.no_accessible_projects).toBeUndefined();
  });

  // BUG #144 (2026-05-03): the previous catch swallowed the underlying
  // error via `console.error` only — agent callers had no way to triage
  // without prod-log access, so every backend failure looked identical.
  // Now `error_message` carries the original message to the response.
  it('propagates the underlying error_message (BUG #144 regression guard)', async () => {
    vi.mocked(listMemberProjects).mockResolvedValueOnce([
      { id: 'proj-a' } as never,
    ]);
    vi.mocked(hybridSearchAllProjects).mockRejectedValueOnce(
      new Error('connect ECONNREFUSED 127.0.0.1:6333'),
    );

    const config = buildServerConfig();
    const result = await handleContext({ task_description: 'auth' }, config);

    expect(result.infrastructure_error).toBe(true);
    expect(result.error_message).toContain('ECONNREFUSED');
  });
});
