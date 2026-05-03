import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock cloud clients
vi.mock('../../../src/config/store.js', () => ({
  loadConfig: vi.fn().mockResolvedValue({
    org_id: 'test-org-id',
    org_name: 'Test Org',
    api_key: 'tm_test123',
    author_name: 'tester',
    supabase_url: 'https://test.supabase.co',
    supabase_service_role_key: 'test-key',
    qdrant_url: 'https://test.qdrant.io',
    qdrant_api_key: 'test-qdrant-key',
    configured_ides: [],
    created_at: new Date().toISOString(),
  }),
}));

vi.mock('../../../src/config/project.js', () => ({
  resolveConfig: vi.fn().mockResolvedValue({
    global: {
      org_id: 'test-org-id',
      org_name: 'Test Org',
      api_key: 'tm_test123',
      author_name: 'tester',
      supabase_url: 'https://test.supabase.co',
      supabase_service_role_key: 'test-key',
      qdrant_url: 'https://test.qdrant.io',
      qdrant_api_key: 'test-qdrant-key',
      configured_ides: [],
      created_at: new Date().toISOString(),
    },
    project: {
      project_id: 'test-project-id',
      project_name: 'Test Project',
    },
  }),
}));

vi.mock('../../../src/cloud/supabase.js', () => ({
  getSupabaseClient: vi.fn().mockReturnValue({}),
  storeDecision: vi.fn().mockResolvedValue({
    id: 'mock-decision-id',
    org_id: 'test-org-id',
    type: 'decision',
    detail: 'test decision text',
    status: 'active',
    author: 'tester',
    source: 'mcp_store',
    content_hash: 'abc123',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }),
}));

vi.mock('../../../src/cloud/qdrant.js', () => ({
  getQdrantClient: vi.fn().mockReturnValue({}),
  upsertDecision: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../src/offline/queue.js', () => ({
  appendToQueue: vi.fn().mockResolvedValue('queued-id'),
}));

import { handleStore } from '../../../src/mcp/tools/store.js';

describe('handleStore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('stores a valid decision', async () => {
    const result = await handleStore({
      text: 'We chose PostgreSQL for our user data storage because of ACID compliance',
      type: 'decision',
      summary: 'Chose PostgreSQL',
      affects: ['database'],
    });

    expect(result).toHaveProperty('id');
    expect(result).toHaveProperty('status', 'stored');
  });

  it('blocks secrets', async () => {
    const result = await handleStore({
      text: 'Use this key: AKIAIOSFODNN7EXAMPLE to access AWS',
    });

    expect(result).toHaveProperty('error', 'secret_detected');
    expect(result).toHaveProperty('action', 'blocked');
  });

  it('detects duplicates', async () => {
    const text = 'Unique decision text for duplicate detection test in store handler';
    await handleStore({ text });
    const result = await handleStore({ text });

    expect(result).toHaveProperty('status', 'duplicate');
  });

  it('returns infrastructure_error in server mode (BUG #143 regression guard)', async () => {
    // Repro the BUG #143 condition: in server mode (configOverride
    // present), the primary write path throws — we must NOT fall through
    // to appendToQueue (which mkdir's a sandbox-unwritable home dir on
    // Vercel and masks the real error). Instead, surface a structured
    // infrastructure_error with the original message.
    const supabaseMod = await import('../../../src/cloud/supabase.js');
    const queueMod = await import('../../../src/offline/queue.js');
    const appendSpy = vi.mocked(queueMod.appendToQueue);
    appendSpy.mockClear();
    vi.mocked(supabaseMod.storeDecision).mockRejectedValueOnce(
      new Error('upstream Postgres timeout'),
    );

    const result = await handleStore(
      {
        text: 'Server-mode error path test — server mode must not write to local queue',
        type: 'decision',
        summary: 'Server-mode error guard',
        affects: ['infra'],
      },
      {
        org_id: 'test-org-id',
        api_key: 'tm_test123',
        author_name: 'tester',
        supabase_url: 'https://test.supabase.co',
        supabase_service_role_key: 'test-key',
        qdrant_url: 'https://test.qdrant.io',
        qdrant_api_key: 'test-qdrant-key',
        project_id: 'test-project-id',
      } as never,
    );

    expect(result).toHaveProperty('error', 'infrastructure_error');
    expect(result).toHaveProperty('action', 'blocked');
    expect(result).toMatchObject({ error_message: expect.stringContaining('upstream Postgres timeout') });
    // Critical: server mode never touches the local-queue fs path.
    expect(appendSpy).not.toHaveBeenCalled();
  });
});
