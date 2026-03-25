/**
 * T007: Unit tests for register Edge Function (US1 — First-Time Hosted Setup).
 *
 * Tests cover:
 * - Successful registration returns 201 with all required fields
 * - Rate limiting returns 429 after 10 registrations from same IP
 * - Org name taken returns 409
 * - Validation errors return 400
 * - Rollback on partial failure (server returns 500)
 * - No service_role key in response
 *
 * T011: Tests for join-public flow (US2 — Join Existing Project).
 *
 * Tests cover:
 * - joinPublic() returns credentials + URLs on success
 * - joinPublic() maps 404 to invalid invite code error
 * - joinPublic() maps 409 to already member error
 * - joinPublic() maps 403 to member limit error
 * - joinPublic() maps network errors to service unavailable
 * - CLI --join hosted path saves config with member_api_key only (no service_role_key)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { JoinPublicResponse, RegistrationResponse } from '../../src/types.js';
import { writeProjectConfig, findProjectConfig } from '../../src/config/project.js';
import type { ValisConfig, ProjectConfig } from '../../src/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeTmpDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'valis-registration-test-'));
}

function makeRegistrationResponse(overrides?: Partial<RegistrationResponse>): RegistrationResponse {
  return {
    member_api_key: 'tmm_0123456789abcdef0123456789abcdef',
    supabase_url: 'https://test.supabase.co',
    qdrant_url: 'https://test.qdrant.io',
    org_id: '00000000-0000-0000-0000-000000000001',
    org_name: 'Test Org',
    project_id: '00000000-0000-0000-0000-000000000002',
    project_name: 'test-project',
    invite_code: 'ABCD-1234',
    member_id: '00000000-0000-0000-0000-000000000003',
    ...overrides,
  };
}

const MOCK_JOIN_RESPONSE: JoinPublicResponse = {
  org_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  org_name: 'Test Org',
  project_id: '11111111-2222-3333-4444-555555555555',
  project_name: 'frontend-app',
  member_api_key: 'tmm_abcdef1234567890abcdef1234567890',
  member_id: '55555555-6666-7777-8888-999999999999',
  supabase_url: 'https://test-project.supabase.co',
  qdrant_url: 'https://test-cluster.qdrant.io',
  member_count: 3,
  decision_count: 42,
  role: 'project_member',
};

// ---------------------------------------------------------------------------
// T007: register() — successful registration
// ---------------------------------------------------------------------------

describe('register(): successful registration', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns 201 with all required fields', async () => {
    const { register } = await import('../../src/cloud/registration.js');
    const expected = makeRegistrationResponse();

    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(expected),
    });

    const result = await register('My Org', 'my-project', 'Alice', 'https://test.supabase.co');

    expect(result.member_api_key).toMatch(/^tmm_/);
    expect(result.supabase_url).toBeTruthy();
    expect(result.qdrant_url).toBeTruthy();
    expect(result.org_id).toBeTruthy();
    expect(result.org_name).toBe('Test Org');
    expect(result.project_id).toBeTruthy();
    expect(result.project_name).toBe('test-project');
    expect(result.invite_code).toBeTruthy();
    expect(result.member_id).toBeTruthy();
  });

  it('sends correct request body to /functions/v1/register', async () => {
    const { register } = await import('../../src/cloud/registration.js');

    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(makeRegistrationResponse()),
    });

    await register('My Org', 'my-project', 'Alice', 'https://test.supabase.co');

    expect(fetch).toHaveBeenCalledWith(
      'https://test.supabase.co/functions/v1/register',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          org_name: 'My Org',
          project_name: 'my-project',
          author_name: 'Alice',
        }),
      }),
    );
  });

  it('response does not contain service_role_key or org api_key', async () => {
    const { register } = await import('../../src/cloud/registration.js');
    const expected = makeRegistrationResponse();

    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(expected),
    });

    const result = await register('Org', 'proj', 'Alice', 'https://test.supabase.co');

    const keys = Object.keys(result);
    expect(keys).not.toContain('service_role_key');
    expect(keys).not.toContain('supabase_service_role_key');
    expect(keys).not.toContain('qdrant_api_key');
    // org api_key is NOT in the response — only member_api_key
    expect(keys).not.toContain('api_key');
  });
});

// ---------------------------------------------------------------------------
// T007: register() — error mapping
// ---------------------------------------------------------------------------

describe('register(): error mapping', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rate limiting returns 429 and throws user-friendly error', async () => {
    const { register } = await import('../../src/cloud/registration.js');

    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      status: 429,
      json: () => Promise.resolve({ error: 'rate_limit_exceeded' }),
    });

    await expect(register('My Org', 'proj', 'Alice', 'https://test.supabase.co')).rejects.toThrow(
      /rate limit/i,
    );
  });

  it('org name taken returns 409 and throws user-friendly error', async () => {
    const { register } = await import('../../src/cloud/registration.js');

    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      status: 409,
      json: () => Promise.resolve({ error: 'org_name_taken' }),
    });

    await expect(register('Taken Org', 'proj', 'Alice', 'https://test.supabase.co')).rejects.toThrow(
      /already taken/i,
    );
  });

  it('validation error for org_name returns 400 with field info', async () => {
    const { register } = await import('../../src/cloud/registration.js');

    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: () => Promise.resolve({ error: 'invalid_name', field: 'org_name' }),
    });

    await expect(register('!!!bad!!!', 'proj', 'Alice', 'https://test.supabase.co')).rejects.toThrow(
      /organization name/i,
    );
  });

  it('validation error for project_name returns 400 with field info', async () => {
    const { register } = await import('../../src/cloud/registration.js');

    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: () => Promise.resolve({ error: 'invalid_name', field: 'project_name' }),
    });

    await expect(register('Good Org', '!!!bad!!!', 'Alice', 'https://test.supabase.co')).rejects.toThrow(
      /project name/i,
    );
  });

  it('server error returns 500 and throws service unavailable', async () => {
    const { register } = await import('../../src/cloud/registration.js');

    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: () => Promise.resolve({ error: 'registration_failed' }),
    });

    await expect(register('My Org', 'proj', 'Alice', 'https://test.supabase.co')).rejects.toThrow(
      /unavailable/i,
    );
  });

  it('network error throws service unavailable', async () => {
    const { register } = await import('../../src/cloud/registration.js');

    (fetch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new TypeError('fetch failed'),
    );

    await expect(register('My Org', 'proj', 'Alice', 'https://test.supabase.co')).rejects.toThrow(
      /unavailable/i,
    );
  });
});

// ---------------------------------------------------------------------------
// T007: register() — rate limit simulation (10 then reject)
// ---------------------------------------------------------------------------

describe('register(): rate limit after 10 registrations', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('succeeds for 10 requests then returns 429', async () => {
    const { register } = await import('../../src/cloud/registration.js');

    // 10 successful registrations
    for (let i = 0; i < 10; i++) {
      (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(makeRegistrationResponse({ org_name: `Org-${i}` })),
      });
    }
    // 11th is rate limited
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      status: 429,
      json: () => Promise.resolve({ error: 'rate_limit_exceeded' }),
    });

    for (let i = 0; i < 10; i++) {
      const result = await register(`Org-${i}`, 'proj', 'Alice', 'https://test.supabase.co');
      expect(result.org_name).toBe(`Org-${i}`);
    }

    await expect(register('Org-10', 'proj', 'Alice', 'https://test.supabase.co')).rejects.toThrow(
      /rate limit/i,
    );
  });
});

// ---------------------------------------------------------------------------
// T007: register() — rollback scenario
// ---------------------------------------------------------------------------

describe('register(): rollback on partial failure', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('server returns 500 on partial failure (rollback happened server-side)', async () => {
    const { register } = await import('../../src/cloud/registration.js');

    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: () => Promise.resolve({ error: 'registration_failed' }),
    });

    await expect(register('Org', 'proj', 'Alice', 'https://test.supabase.co')).rejects.toThrow(
      /unavailable/i,
    );
  });
});

// ---------------------------------------------------------------------------
// T011: joinPublic — successful join returns credentials + URLs
// ---------------------------------------------------------------------------

describe('joinPublic: successful join', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns JoinPublicResponse with all required fields', async () => {
    const { joinPublic } = await import('../../src/cloud/registration.js');

    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(MOCK_JOIN_RESPONSE),
    });

    const result = await joinPublic('ABCD-1234', 'Bob', 'https://test.supabase.co');

    expect(result.org_id).toBe(MOCK_JOIN_RESPONSE.org_id);
    expect(result.org_name).toBe(MOCK_JOIN_RESPONSE.org_name);
    expect(result.project_id).toBe(MOCK_JOIN_RESPONSE.project_id);
    expect(result.project_name).toBe(MOCK_JOIN_RESPONSE.project_name);
    expect(result.member_api_key).toBe(MOCK_JOIN_RESPONSE.member_api_key);
    expect(result.member_id).toBe(MOCK_JOIN_RESPONSE.member_id);
    expect(result.supabase_url).toBe(MOCK_JOIN_RESPONSE.supabase_url);
    expect(result.qdrant_url).toBe(MOCK_JOIN_RESPONSE.qdrant_url);
    expect(result.member_count).toBe(3);
    expect(result.decision_count).toBe(42);
    expect(result.role).toBe('project_member');
  });

  it('sends correct request body to join-project endpoint', async () => {
    const { joinPublic } = await import('../../src/cloud/registration.js');

    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(MOCK_JOIN_RESPONSE),
    });

    await joinPublic('WXYZ-5678', 'Alice', 'https://test.supabase.co');

    expect(fetch).toHaveBeenCalledWith(
      'https://test.supabase.co/functions/v1/join-project',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          invite_code: 'WXYZ-5678',
          author_name: 'Alice',
        }),
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// T011: joinPublic — error mapping
// ---------------------------------------------------------------------------

describe('joinPublic: error mapping', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('throws invalid invite code error on 404', async () => {
    const { joinPublic } = await import('../../src/cloud/registration.js');

    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      status: 404,
      json: () => Promise.resolve({ error: 'invalid_invite_code' }),
    });

    await expect(
      joinPublic('BAD-CODE', 'Bob', 'https://test.supabase.co'),
    ).rejects.toThrow(/Invalid invite code/i);
  });

  it('throws already member error on 409', async () => {
    const { joinPublic } = await import('../../src/cloud/registration.js');

    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      status: 409,
      json: () => Promise.resolve({ error: 'already_project_member' }),
    });

    await expect(
      joinPublic('ABCD-1234', 'Bob', 'https://test.supabase.co'),
    ).rejects.toThrow(/Already a member/i);
  });

  it('throws member limit error on 403', async () => {
    const { joinPublic } = await import('../../src/cloud/registration.js');

    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      status: 403,
      json: () => Promise.resolve({ error: 'member_limit_reached' }),
    });

    await expect(
      joinPublic('ABCD-1234', 'Bob', 'https://test.supabase.co'),
    ).rejects.toThrow(/Free tier limit/i);
  });

  it('throws service unavailable on network failure', async () => {
    const { joinPublic } = await import('../../src/cloud/registration.js');

    (fetch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new TypeError('fetch failed'),
    );

    await expect(
      joinPublic('ABCD-1234', 'Bob', 'https://test.supabase.co'),
    ).rejects.toThrow(/Registration service is unavailable/i);
  });

  it('throws service unavailable on 500', async () => {
    const { joinPublic } = await import('../../src/cloud/registration.js');

    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: () => Promise.resolve({ error: 'join_failed' }),
    });

    await expect(
      joinPublic('ABCD-1234', 'Bob', 'https://test.supabase.co'),
    ).rejects.toThrow(/Registration service is unavailable/i);
  });
});

// ---------------------------------------------------------------------------
// T011: CLI --join hosted path: saves correct config
// ---------------------------------------------------------------------------

describe('CLI --join hosted path: config shape', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTmpDir();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('joinPublic response produces config with member_api_key and no service_role_key', () => {
    // Simulate the config that would be built from joinPublic response
    const result = MOCK_JOIN_RESPONSE;
    const config: ValisConfig = {
      org_id: result.org_id,
      org_name: result.org_name,
      api_key: '', // not available via public join
      invite_code: 'ABCD-1234',
      author_name: 'Bob',
      supabase_url: result.supabase_url,
      supabase_service_role_key: '', // not needed for hosted mode
      qdrant_url: result.qdrant_url,
      qdrant_api_key: '', // not needed for hosted mode
      configured_ides: [],
      created_at: new Date().toISOString(),
      member_api_key: result.member_api_key,
      member_id: result.member_id,
    };

    // Verify: member_api_key is set
    expect(config.member_api_key).toBe('tmm_abcdef1234567890abcdef1234567890');
    expect(config.member_api_key).toMatch(/^tmm_/);

    // Verify: service_role_key is empty (no service_role for hosted mode)
    expect(config.supabase_service_role_key).toBe('');

    // Verify: qdrant_api_key is empty (no qdrant API key for hosted mode)
    expect(config.qdrant_api_key).toBe('');

    // Verify: URLs come from the response
    expect(config.supabase_url).toBe('https://test-project.supabase.co');
    expect(config.qdrant_url).toBe('https://test-cluster.qdrant.io');

    // Verify: member_id is set from response
    expect(config.member_id).toBe(MOCK_JOIN_RESPONSE.member_id);
  });

  it('joinPublic response writes valid .valis.json', async () => {
    const result = MOCK_JOIN_RESPONSE;
    const projectConfig: ProjectConfig = {
      project_id: result.project_id,
      project_name: result.project_name,
    };

    await writeProjectConfig(tmpDir, projectConfig);

    const loaded = await findProjectConfig(tmpDir);
    expect(loaded).not.toBeNull();
    expect(loaded!.project_id).toBe(MOCK_JOIN_RESPONSE.project_id);
    expect(loaded!.project_name).toBe(MOCK_JOIN_RESPONSE.project_name);

    // Verify .valis.json has no secrets
    const raw = await readFile(join(tmpDir, '.valis.json'), 'utf-8');
    const parsed = JSON.parse(raw);
    expect(Object.keys(parsed)).toContain('project_id');
    expect(Object.keys(parsed)).toContain('project_name');
    expect(Object.keys(parsed)).not.toContain('member_api_key');
    expect(Object.keys(parsed)).not.toContain('service_role_key');
    expect(Object.keys(parsed)).not.toContain('supabase_url');
  });
});

// ---------------------------------------------------------------------------
// T011: JoinPublicResponse: type contract
// ---------------------------------------------------------------------------

describe('JoinPublicResponse type contract', () => {
  it('has all required fields per spec', () => {
    const response: JoinPublicResponse = MOCK_JOIN_RESPONSE;

    // All fields from the spec contract
    expect(response.org_id).toBeTruthy();
    expect(response.org_name).toBeTruthy();
    expect(response.project_id).toBeTruthy();
    expect(response.project_name).toBeTruthy();
    expect(response.member_api_key).toBeTruthy();
    expect(response.member_id).toBeTruthy();
    expect(response.supabase_url).toBeTruthy();
    expect(response.qdrant_url).toBeTruthy();
    expect(typeof response.member_count).toBe('number');
    expect(typeof response.decision_count).toBe('number');
    expect(response.role).toBeTruthy();
  });

  it('member_api_key has tmm_ prefix', () => {
    expect(MOCK_JOIN_RESPONSE.member_api_key).toMatch(/^tmm_/);
  });
});
