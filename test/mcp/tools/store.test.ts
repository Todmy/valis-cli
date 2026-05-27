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

vi.mock('../../../src/lib/project-access.js', () => ({
  resolveProjectOrg: vi.fn(),
  // PR #57: getServiceRoleSupabase is the typed factory. store.ts calls it
  // to pass to resolveProjectOrg (which is mocked). Return an empty object
  // — resolveProjectOrg never actually uses it under the mock.
  getServiceRoleSupabase: vi.fn(() => ({})),
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

  it('refuses to write on project_scope_mismatch (BUG #175 regression guard)', async () => {
    // Repro the symptom: agent passes project_id (from .valis.json in the
    // working directory) that differs from the OAuth session's project_id
    // (encoded in the JWT). Previously the store silently wrote to the
    // session's project — symptom on dogfood: decisions for `mojob` landed
    // in `personal` because the JWT carried `personal`. Now we block with
    // a structured signal so the agent can surface a restart-session
    // instruction to the user.
    const supabaseMod = await import('../../../src/cloud/supabase.js');
    const storeSpy = vi.mocked(supabaseMod.storeDecision);
    storeSpy.mockClear();

    const result = await handleStore(
      {
        text: 'Decision intended for project mojob but session JWT scopes personal',
        type: 'decision',
        summary: 'project mismatch repro',
        affects: ['scope'],
        project_id: 'project-mojob',
      },
      {
        org_id: 'test-org-id',
        api_key: 'tm_test123',
        author_name: 'tester',
        supabase_url: 'https://test.supabase.co',
        supabase_service_role_key: 'test-key',
        qdrant_url: 'https://test.qdrant.io',
        qdrant_api_key: 'test-qdrant-key',
        project_id: 'project-personal',
      } as never,
    );

    expect(result).toHaveProperty('error', 'project_scope_mismatch');
    expect(result).toHaveProperty('action', 'blocked');
    expect(result).toMatchObject({
      project_scope_mismatch: {
        session_project_id: 'project-personal',
        current_project_id: 'project-mojob',
        action_required: 'restart_session',
      },
    });
    // Critical: no write went through to Supabase / Qdrant.
    expect(storeSpy).not.toHaveBeenCalled();
  });

  it('accepts a store when args.project_id matches the session scope', async () => {
    // Inverse of the regression: when the two project_ids agree, the store
    // proceeds normally — the guard is targeted, not paranoid.
    const supabaseMod = await import('../../../src/cloud/supabase.js');
    const storeSpy = vi.mocked(supabaseMod.storeDecision);
    storeSpy.mockClear();

    const result = await handleStore(
      {
        text: 'Decision properly scoped to the active project — should succeed',
        type: 'decision',
        summary: 'matched scope',
        affects: ['scope'],
        project_id: 'project-aligned',
      },
      {
        org_id: 'test-org-id',
        api_key: 'tm_test123',
        author_name: 'tester',
        supabase_url: 'https://test.supabase.co',
        supabase_service_role_key: 'test-key',
        qdrant_url: 'https://test.qdrant.io',
        qdrant_api_key: 'test-qdrant-key',
        project_id: 'project-aligned',
      } as never,
    );

    expect(result).not.toHaveProperty('error');
    expect(result).toHaveProperty('id');
  });

  describe('project_id org resolution (#176 root)', () => {
    // When an OAuth caller passes args.project_id AND configOverride.project_id
    // differs (or is absent), handleStore must resolve the project's actual
    // org_id and use it for the write — otherwise the row lands under the
    // auth-resolved (typically personal) org while pointing at a foreign
    // project, producing unreachable cross-org rows.

    it('resolves target org and overrides config.org_id for storeDecision', async () => {
      const accessMod = await import('../../../src/lib/project-access.js');
      const supabaseMod = await import('../../../src/cloud/supabase.js');
      vi.mocked(accessMod.resolveProjectOrg).mockResolvedValueOnce({
        org_id: 'mojob-org-id',
      });
      const storeSpy = vi.mocked(supabaseMod.storeDecision);
      storeSpy.mockClear();

      const result = await handleStore(
        {
          text: 'Cross-org store: caller in personal-org JWT writes for mojob project',
          type: 'decision',
          summary: 'Cross-org resolve',
          affects: ['scope'],
          project_id: 'project-mojob',
        },
        {
          org_id: 'personal-org-id',
          member_id: 'caller-member-id',
          api_key: 'tm_test123',
          author_name: 'tester',
          supabase_url: 'https://test.supabase.co',
          supabase_service_role_key: 'test-key',
          qdrant_url: 'https://test.qdrant.io',
          qdrant_api_key: 'test-qdrant-key',
          // No configOverride.project_id → resolve path triggers.
        } as never,
      );

      expect(result).not.toHaveProperty('error');
      expect(accessMod.resolveProjectOrg).toHaveBeenCalledWith(
        expect.any(Object),
        'caller-member-id',
        'project-mojob',
      );
      // Load-bearing: storeDecision must receive the RESOLVED org, not the
      // caller's auth-resolved personal org. Extras (6th arg) varies based
      // on default status logic — not load-bearing for this assertion.
      const lastCall = storeSpy.mock.calls.at(-1);
      expect(lastCall?.[1]).toBe('mojob-org-id');
    });

    it('propagates project_not_found from resolver as blocked error', async () => {
      const accessMod = await import('../../../src/lib/project-access.js');
      const supabaseMod = await import('../../../src/cloud/supabase.js');
      vi.mocked(accessMod.resolveProjectOrg).mockResolvedValueOnce({
        error: 'project_not_found',
      });
      const storeSpy = vi.mocked(supabaseMod.storeDecision);
      storeSpy.mockClear();

      const result = await handleStore(
        {
          text: 'Caller targets a project_id that no longer exists in projects',
          type: 'decision',
          summary: 'Project gone',
          project_id: 'project-deleted',
        },
        {
          org_id: 'personal-org-id',
          member_id: 'caller-member-id',
          api_key: 'tm_test123',
          author_name: 'tester',
          supabase_url: 'https://test.supabase.co',
          supabase_service_role_key: 'test-key',
          qdrant_url: 'https://test.qdrant.io',
          qdrant_api_key: 'test-qdrant-key',
        } as never,
      );

      expect(result).toMatchObject({
        error: 'project_not_found',
        action: 'blocked',
      });
      expect(storeSpy).not.toHaveBeenCalled();
    });

    it('propagates project_access_denied from resolver', async () => {
      const accessMod = await import('../../../src/lib/project-access.js');
      const supabaseMod = await import('../../../src/cloud/supabase.js');
      vi.mocked(accessMod.resolveProjectOrg).mockResolvedValueOnce({
        error: 'project_access_denied',
      });
      const storeSpy = vi.mocked(supabaseMod.storeDecision);
      storeSpy.mockClear();

      const result = await handleStore(
        {
          text: 'Caller is not a member of the targeted project — must be blocked',
          type: 'decision',
          summary: 'Not a member',
          project_id: 'project-foreign',
        },
        {
          org_id: 'personal-org-id',
          member_id: 'caller-member-id',
          api_key: 'tm_test123',
          author_name: 'tester',
          supabase_url: 'https://test.supabase.co',
          supabase_service_role_key: 'test-key',
          qdrant_url: 'https://test.qdrant.io',
          qdrant_api_key: 'test-qdrant-key',
        } as never,
      );

      expect(result).toMatchObject({
        error: 'project_access_denied',
        action: 'blocked',
      });
      expect(storeSpy).not.toHaveBeenCalled();
    });

    it('skips the resolver when configOverride.project_id matches args.project_id', async () => {
      // Optimisation guard: when the JWT already carried a project claim that
      // matches args.project_id, authenticateRequest already narrowed org_id
      // correctly. No extra DB roundtrip needed.
      const accessMod = await import('../../../src/lib/project-access.js');
      vi.mocked(accessMod.resolveProjectOrg).mockClear();

      const result = await handleStore(
        {
          text: 'Caller passes project_id matching session scope — resolver skipped',
          type: 'decision',
          summary: 'Skip resolver',
          project_id: 'project-aligned',
        },
        {
          org_id: 'aligned-org-id',
          member_id: 'caller-member-id',
          api_key: 'tm_test123',
          author_name: 'tester',
          supabase_url: 'https://test.supabase.co',
          supabase_service_role_key: 'test-key',
          qdrant_url: 'https://test.qdrant.io',
          qdrant_api_key: 'test-qdrant-key',
          project_id: 'project-aligned',
        } as never,
      );

      expect(result).not.toHaveProperty('error');
      expect(accessMod.resolveProjectOrg).not.toHaveBeenCalled();
    });
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
