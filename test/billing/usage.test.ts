import { describe, it, expect, vi, beforeEach } from 'vitest';
import { checkUsageOrProceed } from '../../src/billing/usage.js';

// ---------------------------------------------------------------------------
// T075: Unit tests for billing usage check — fail-open guarantee
//
// These tests verify the core invariant: billing NEVER blocks operations
// (Constitution III). On any error (network, timeout, Edge Function error),
// operations proceed.
// ---------------------------------------------------------------------------

// Mock loadConfig
vi.mock('../../src/config/store.js', () => ({
  loadConfig: vi.fn(),
}));

// Mock getToken
vi.mock('../../src/auth/jwt.js', () => ({
  getToken: vi.fn(),
}));

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// Import mocked modules
import { loadConfig } from '../../src/config/store.js';
import { getToken } from '../../src/auth/jwt.js';

const mockConfig = {
  org_id: 'org-123',
  org_name: 'Test Org',
  api_key: 'tm_test',
  invite_code: 'TEST-1234',
  author_name: 'test-user',
  supabase_url: 'https://test.supabase.co',
  supabase_service_role_key: 'test-service-role-key',
  qdrant_url: 'https://qdrant.test',
  qdrant_api_key: 'test-qdrant-key',
  configured_ides: [],
  created_at: new Date().toISOString(),
  auth_mode: 'jwt' as const,
  member_api_key: 'tmm_test',
  member_id: 'member-123',
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(loadConfig).mockResolvedValue(mockConfig);
  vi.mocked(getToken).mockResolvedValue({
    jwt: { token: 'jwt-token', expires_at: new Date(Date.now() + 3600000).toISOString() },
    member_id: 'member-123',
    org_id: 'org-123',
    role: 'admin',
    author_name: 'test-user',
  });
});

describe('checkUsageOrProceed', () => {
  describe('fail-open guarantee', () => {
    it('returns allowed=true when config is null', async () => {
      vi.mocked(loadConfig).mockResolvedValue(null);
      const result = await checkUsageOrProceed('https://test.supabase.co', 'test-api-key', 'org-123', 'store');
      expect(result.allowed).toBe(true);
    });

    it('returns allowed=true on network error', async () => {
      mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));
      const result = await checkUsageOrProceed('https://test.supabase.co', 'test-api-key', 'org-123', 'store');
      expect(result.allowed).toBe(true);
    });

    it('returns allowed=true on timeout', async () => {
      mockFetch.mockRejectedValue(new DOMException('Aborted', 'AbortError'));
      const result = await checkUsageOrProceed('https://test.supabase.co', 'test-api-key', 'org-123', 'store');
      expect(result.allowed).toBe(true);
    });

    it('returns allowed=true on non-OK HTTP response', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
      });
      const result = await checkUsageOrProceed('https://test.supabase.co', 'test-api-key', 'org-123', 'store');
      expect(result.allowed).toBe(true);
    });

    it('returns allowed=true on JSON parse error', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => { throw new SyntaxError('Unexpected token'); },
      });
      const result = await checkUsageOrProceed('https://test.supabase.co', 'test-api-key', 'org-123', 'store');
      expect(result.allowed).toBe(true);
    });

    it('returns allowed=true when Edge Function returns allowed:true', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ allowed: true, plan: 'free' }),
      });
      const result = await checkUsageOrProceed('https://test.supabase.co', 'test-api-key', 'org-123', 'store');
      expect(result.allowed).toBe(true);
    });
  });

  describe('denied response (free tier)', () => {
    it('returns allowed=false with message when denied', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          allowed: false,
          plan: 'free',
          reason: 'Free tier limit reached (100/100 decisions).',
          upgrade: {
            message: 'Upgrade to Team ($29/mo) for 5,000 decisions.',
            checkout_url: 'https://checkout.stripe.com/test',
          },
        }),
      });
      const result = await checkUsageOrProceed('https://test.supabase.co', 'test-api-key', 'org-123', 'store');
      expect(result.allowed).toBe(false);
      expect(result.message).toContain('Free tier limit reached');
      expect(result.upgrade).toBeDefined();
      expect(result.upgrade!.checkout_url).toBe('https://checkout.stripe.com/test');
    });

    it('returns allowed=false for search denial', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          allowed: false,
          plan: 'free',
          reason: 'Free tier limit reached (100/100 searches/day).',
          upgrade: {
            message: 'Upgrade to Team ($29/mo) for 1,000 searches/day.',
            checkout_url: null,
          },
        }),
      });
      const result = await checkUsageOrProceed('org-123', 'search');
      expect(result.allowed).toBe(false);
      expect(result.message).toContain('searches/day');
    });
  });

  describe('overage response (paid tier)', () => {
    it('returns allowed=true when overage is tracked', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          allowed: true,
          plan: 'team',
          overage: true,
          overage_rate: '$0.005 per decision',
        }),
      });
      const result = await checkUsageOrProceed('https://test.supabase.co', 'test-api-key', 'org-123', 'store');
      expect(result.allowed).toBe(true);
    });
  });

  describe('auth handling', () => {
    it('uses JWT token when in jwt auth mode', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ allowed: true }),
      });
      await checkUsageOrProceed('https://test.supabase.co', 'test-api-key', 'org-123', 'store');
      expect(mockFetch).toHaveBeenCalledOnce();
      const callArgs = mockFetch.mock.calls[0];
      expect(callArgs[1].headers.Authorization).toBe('Bearer jwt-token');
    });

    it('fail-open when no JWT token available', async () => {
      vi.mocked(getToken).mockResolvedValue(null);
      const result = await checkUsageOrProceed('https://test.supabase.co', 'test-api-key', 'org-123', 'store');
      expect(result.allowed).toBe(true);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('fail-open when getToken throws', async () => {
      vi.mocked(getToken).mockRejectedValue(new Error('Token error'));
      const result = await checkUsageOrProceed('https://test.supabase.co', 'test-api-key', 'org-123', 'store');
      expect(result.allowed).toBe(true);
    });
  });

  describe('request format', () => {
    it('sends correct request to check-usage endpoint', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ allowed: true }),
      });
      await checkUsageOrProceed('https://test.supabase.co', 'test-api-key', 'org-123', 'store');

      const [url, options] = mockFetch.mock.calls[0];
      expect(url).toBe('https://test.supabase.co/functions/v1/check-usage');
      expect(options.method).toBe('POST');
      expect(options.headers['Content-Type']).toBe('application/json');
      const body = JSON.parse(options.body);
      expect(body.org_id).toBe('org-123');
      expect(body.operation).toBe('store');
    });

    it('includes AbortSignal for timeout', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ allowed: true }),
      });
      await checkUsageOrProceed('org-123', 'search');

      const [, options] = mockFetch.mock.calls[0];
      expect(options.signal).toBeDefined();
    });
  });
});
