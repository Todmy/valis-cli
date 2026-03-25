/**
 * T035: Tests for enrichCommand — verifies community enrichment still works
 * with local keys (no regression), and hosted mode delegates to /api/enrich.
 *
 * Tests:
 * - Community mode calls runEnrichment (local pipeline) when auth_mode != jwt
 * - Community mode calls runEnrichment when isHostedMode returns false
 * - Hosted mode (auth_mode=jwt + hosted config) calls fetch to /api/enrich
 * - No config exits with error
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockLoadConfig = vi.fn();
vi.mock('../../src/config/store.js', () => ({
  loadConfig: () => mockLoadConfig(),
}));

const mockGetSupabaseClient = vi.fn();
vi.mock('../../src/cloud/supabase.js', () => ({
  getSupabaseClient: (...args: unknown[]) => mockGetSupabaseClient(...args),
}));

const mockGetQdrantClient = vi.fn();
vi.mock('../../src/cloud/qdrant.js', () => ({
  getQdrantClient: (...args: unknown[]) => mockGetQdrantClient(...args),
}));

const mockRunEnrichment = vi.fn();
vi.mock('../../src/enrichment/runner.js', () => ({
  runEnrichment: (...args: unknown[]) => mockRunEnrichment(...args),
}));

const mockGetToken = vi.fn();
vi.mock('../../src/auth/jwt.js', () => ({
  getToken: (...args: unknown[]) => mockGetToken(...args),
}));

// Mock picocolors to avoid ANSI codes in test output
vi.mock('picocolors', () => ({
  default: {
    bold: (s: string) => s,
    yellow: (s: string) => s,
    cyan: (s: string) => s,
    green: (s: string) => s,
    red: (s: string) => s,
    dim: (s: string) => s,
  },
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { enrichCommand } from '../../src/commands/enrich.js';
import { HOSTED_SUPABASE_URL } from '../../src/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const COMMUNITY_CONFIG = {
  org_id: 'org-community',
  org_name: 'Test Org',
  api_key: 'tm_abc123',
  invite_code: 'ABCD-EFGH',
  author_name: 'Alice',
  supabase_url: 'https://my-self-hosted.supabase.co',
  supabase_service_role_key: 'service-role-key-here',
  qdrant_url: 'https://my-qdrant.cloud.io',
  qdrant_api_key: 'qdrant-key',
  configured_ides: [],
  created_at: '2026-01-01T00:00:00Z',
  auth_mode: 'legacy' as const,
  member_api_key: null,
  member_id: null,
};

const HOSTED_CONFIG = {
  org_id: 'org-hosted',
  org_name: 'Hosted Org',
  api_key: 'tm_hosted',
  invite_code: 'WXYZ-1234',
  author_name: 'Bob',
  supabase_url: HOSTED_SUPABASE_URL,
  supabase_service_role_key: '', // hosted users don't have service role key
  qdrant_url: 'https://qdrant.hosted.io',
  qdrant_api_key: 'hosted-qdrant-key',
  configured_ides: [],
  created_at: '2026-01-01T00:00:00Z',
  auth_mode: 'jwt' as const,
  member_api_key: 'tmm_hosted_key',
  member_id: 'member-hosted',
  project_id: 'proj-hosted',
  project_name: 'My Project',
};

// Prevent process.exit from actually exiting
const mockExit = vi.spyOn(process, 'exit').mockImplementation((() => {
  throw new Error('process.exit called');
}) as never);

const mockConsoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
const mockConsoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
const mockConsoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('enrichCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSupabaseClient.mockReturnValue({});
    mockGetQdrantClient.mockReturnValue({});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ---- No config ----

  it('exits with error when no config exists', async () => {
    mockLoadConfig.mockResolvedValue(null);

    await expect(enrichCommand({})).rejects.toThrow('process.exit called');
    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining('not configured'),
    );
  });

  // ---- Community mode uses local enrichment (T035 regression) ----

  it('runs local enrichment for community config (auth_mode=legacy)', async () => {
    mockLoadConfig.mockResolvedValue(COMMUNITY_CONFIG);
    mockRunEnrichment.mockResolvedValue({
      mode: 'applied',
      enriched: 2,
      failed: 0,
      candidates: 2,
      remaining: 0,
      details: [],
      message: 'Enriched 2/2 pending decision(s) via anthropic.',
    });

    await enrichCommand({});

    // Verify runEnrichment was called (local pipeline)
    expect(mockRunEnrichment).toHaveBeenCalledTimes(1);
    expect(mockRunEnrichment).toHaveBeenCalledWith(
      expect.anything(), // supabase client
      expect.anything(), // qdrant client
      expect.objectContaining({
        orgId: 'org-community',
        dryRun: false,
      }),
    );

    // Verify getToken was NOT called (no hosted delegation)
    expect(mockGetToken).not.toHaveBeenCalled();
  });

  it('runs local enrichment in dry-run mode for community config', async () => {
    mockLoadConfig.mockResolvedValue(COMMUNITY_CONFIG);
    mockRunEnrichment.mockResolvedValue({
      mode: 'dry_run',
      enriched: 0,
      failed: 0,
      candidates: 5,
      remaining: 5,
      details: [],
      message: 'Found 5 pending decision(s). Omit --dry-run to enrich.',
    });

    await enrichCommand({ dryRun: true });

    expect(mockRunEnrichment).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        orgId: 'org-community',
        dryRun: true,
      }),
    );
  });

  it('passes provider and ceiling options to local enrichment', async () => {
    mockLoadConfig.mockResolvedValue(COMMUNITY_CONFIG);
    mockRunEnrichment.mockResolvedValue({
      mode: 'applied',
      enriched: 1,
      failed: 0,
      candidates: 1,
      remaining: 0,
      details: [],
      message: 'Enriched 1/1 pending decision(s) via openai.',
    });

    await enrichCommand({ provider: 'openai', ceiling: '2.50' });

    expect(mockRunEnrichment).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        provider: 'openai',
        ceilingCents: 250,
      }),
    );
  });

  it('runs local enrichment when supabase_url is not HOSTED_SUPABASE_URL (even with jwt mode)', async () => {
    const config = {
      ...COMMUNITY_CONFIG,
      auth_mode: 'jwt' as const,
      member_api_key: 'tmm_local_key',
      member_id: 'member-local',
      // supabase_url is NOT HOSTED_SUPABASE_URL, and service_role_key is set
    };

    mockLoadConfig.mockResolvedValue(config);
    mockRunEnrichment.mockResolvedValue({
      mode: 'applied',
      enriched: 0,
      failed: 0,
      candidates: 0,
      remaining: 0,
      details: [],
      message: 'No pending decisions to enrich.',
    });

    await enrichCommand({});

    // Should use local enrichment, not hosted API
    expect(mockRunEnrichment).toHaveBeenCalledTimes(1);
    expect(mockGetToken).not.toHaveBeenCalled();
  });

  // ---- Hosted mode delegates to /api/enrich ----

  it('delegates to hosted /api/enrich for hosted config (auth_mode=jwt)', async () => {
    mockLoadConfig.mockResolvedValue(HOSTED_CONFIG);

    // Mock getToken to return a JWT
    mockGetToken.mockResolvedValue({
      jwt: { token: 'fake-jwt-token', expires_at: '2099-01-01T00:00:00Z' },
      member_id: 'member-hosted',
      org_id: 'org-hosted',
      role: 'admin',
      author_name: 'Bob',
    });

    // Mock supabase query for pending decisions
    mockGetSupabaseClient.mockReturnValue({
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              is: vi.fn().mockReturnValue({
                order: vi.fn().mockReturnValue({
                  limit: vi.fn().mockReturnValue({
                    eq: vi.fn().mockResolvedValue({
                      data: [{ id: 'dec-1' }, { id: 'dec-2' }],
                      error: null,
                    }),
                  }),
                }),
              }),
            }),
          }),
        }),
      }),
    });

    // Mock the fetch call to /api/enrich
    const mockFetch = vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          enriched: [
            {
              decision_id: 'dec-1',
              type: 'decision',
              summary: 'A decision',
              affects: ['api'],
              confidence: 0.9,
              tokens_used: 300,
              cost_cents: 1,
            },
          ],
          skipped: ['dec-2'],
          total_cost_cents: 1,
          daily_budget_remaining_cents: 99,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    await enrichCommand({});

    // Verify fetch was called with the correct URL and JWT
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [fetchUrl, fetchOptions] = mockFetch.mock.calls[0];
    expect(String(fetchUrl)).toContain('/api/enrich');
    expect((fetchOptions as RequestInit).headers).toMatchObject({
      Authorization: 'Bearer fake-jwt-token',
      'Content-Type': 'application/json',
    });

    // Verify body contains decision IDs
    const fetchBody = JSON.parse((fetchOptions as RequestInit).body as string);
    expect(fetchBody.decision_ids).toEqual(['dec-1', 'dec-2']);

    // Verify local runEnrichment was NOT called
    expect(mockRunEnrichment).not.toHaveBeenCalled();

    mockFetch.mockRestore();
  });

  it('exits with error when hosted auth token cannot be obtained', async () => {
    mockLoadConfig.mockResolvedValue(HOSTED_CONFIG);
    mockGetToken.mockResolvedValue(null);

    await expect(enrichCommand({})).rejects.toThrow('process.exit called');
    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining('Could not obtain auth token'),
    );
  });
});
