/**
 * Feature 033 — public-KB cross-org read tests for `valis_context`.
 * Mirror of `search.public.test.ts` with reduced surface — same gate
 * mechanic, just the context tool entrypoint.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/config/store.js', () => ({
  loadConfig: vi.fn().mockResolvedValue({
    org_id: 'caller-org',
    qdrant_url: 'https://test.qdrant.io',
    qdrant_api_key: 'test-key',
    auth_mode: 'jwt',
    supabase_url: 'https://test.supabase.co',
    supabase_service_role_key: 'srv-key',
  }),
}));

vi.mock('../../../src/cloud/qdrant.js', () => ({
  getQdrantClient: vi.fn().mockReturnValue({}),
  hybridSearch: vi.fn().mockResolvedValue([]),
  hybridSearchAllProjects: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../../src/cloud/search-proxy.js', () => ({
  proxySearch: vi.fn().mockResolvedValue([
    {
      id: 'ctx-1',
      score: 0.9,
      type: 'decision',
      summary: 'Context decision',
      detail: 'Body',
      author: 'publisher',
      affects: ['ux'],
      created_at: '2026-05-01T12:00:00Z',
      confidence: 0.9,
      pinned: false,
      depends_on: [],
      status: 'active',
    },
  ]),
}));

vi.mock('../../../src/cloud/api-url.js', () => ({
  isHostedMode: vi.fn().mockReturnValue(true),
}));

vi.mock('../../../src/cloud/supabase.js', () => ({
  getSupabaseClient: vi.fn().mockReturnValue({}),
  getSupabaseJwtClient: vi.fn().mockReturnValue({}),
  listMemberProjects: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../../src/lib/project-access.js', () => ({
  canReadProject: vi.fn(),
}));

import { handleContext } from '../../../src/mcp/tools/context.js';
import { canReadProject } from '../../../src/lib/project-access.js';
import { proxySearch } from '../../../src/cloud/search-proxy.js';

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

describe('handleContext — public-KB cross-org reads (feature 033)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns context when target project is public', async () => {
    vi.mocked(canReadProject).mockResolvedValueOnce(true);

    const result = await handleContext(
      { task_description: 'how to handle auth', target_project_id: PUBLIC_TARGET },
      httpServerOverride,
    );

    expect(canReadProject).toHaveBeenCalledWith(
      expect.anything(),
      'caller-member-id',
      PUBLIC_TARGET,
    );
    expect(result.total_in_brain).toBeGreaterThanOrEqual(0);
    // Either decisions or grouped buckets must have at least one hit.
    const totalHits =
      result.decisions.length +
      result.constraints.length +
      result.patterns.length +
      result.lessons.length;
    expect(totalHits).toBeGreaterThan(0);
    expect(proxySearch).toHaveBeenCalled();
  });

  it('returns empty context when target project is private (non-member)', async () => {
    vi.mocked(canReadProject).mockResolvedValueOnce(false);

    const result = await handleContext(
      { task_description: 'how to handle auth', target_project_id: 'private-target' },
      httpServerOverride,
    );

    expect(result.decisions).toEqual([]);
    expect(result.constraints).toEqual([]);
    expect(result.patterns).toEqual([]);
    expect(result.lessons).toEqual([]);
    expect(result.total_in_brain).toBe(0);
    expect(proxySearch).not.toHaveBeenCalled();
  });

  it('returns empty context in stdio mode without service-role creds', async () => {
    const result = await handleContext({
      task_description: 'how to handle auth',
      target_project_id: PUBLIC_TARGET,
    });

    expect(canReadProject).not.toHaveBeenCalled();
    expect(result.total_in_brain).toBe(0);
    expect(proxySearch).not.toHaveBeenCalled();
  });

  it('preserves legacy behaviour when target_project_id is omitted', async () => {
    const result = await handleContext(
      { task_description: 'how to handle auth' },
      httpServerOverride,
    );
    expect(canReadProject).not.toHaveBeenCalled();
    expect(proxySearch).toHaveBeenCalled();
  });
});
