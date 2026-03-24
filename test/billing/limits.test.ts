import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  PLAN_LIMITS,
  PLAN_PRICES,
  OVERAGE_RATES,
  checkLimit,
} from '../../src/billing/limits.js';

// ---------------------------------------------------------------------------
// Plan limit constants
// ---------------------------------------------------------------------------

describe('PLAN_LIMITS', () => {
  it('defines four plan tiers', () => {
    expect(Object.keys(PLAN_LIMITS)).toEqual([
      'free',
      'team',
      'business',
      'enterprise',
    ]);
  });

  it('free tier has 500 decisions, 5 members, 100 searches, no overage', () => {
    expect(PLAN_LIMITS.free).toEqual({
      decisions: 500,
      members: 5,
      searches: 100,
      overage: false,
    });
  });

  it('team tier has 5000 decisions and overage enabled', () => {
    expect(PLAN_LIMITS.team.decisions).toBe(5_000);
    expect(PLAN_LIMITS.team.overage).toBe(true);
  });

  it('business tier has 25000 decisions and overage enabled', () => {
    expect(PLAN_LIMITS.business.decisions).toBe(25_000);
    expect(PLAN_LIMITS.business.overage).toBe(true);
  });

  it('enterprise tier has Infinity for all limits', () => {
    expect(PLAN_LIMITS.enterprise.decisions).toBe(Infinity);
    expect(PLAN_LIMITS.enterprise.members).toBe(Infinity);
    expect(PLAN_LIMITS.enterprise.searches).toBe(Infinity);
    expect(PLAN_LIMITS.enterprise.overage).toBe(false);
  });
});

describe('PLAN_PRICES', () => {
  it('team plan has monthly and annual prices', () => {
    expect(PLAN_PRICES.team.monthly).toBeGreaterThan(0);
    expect(PLAN_PRICES.team.annual).toBeGreaterThan(0);
  });

  it('annual price is less than 12x monthly', () => {
    // Annual should offer a discount
    expect(PLAN_PRICES.team.annual).toBeLessThan(
      PLAN_PRICES.team.monthly * 12,
    );
    expect(PLAN_PRICES.business.annual).toBeLessThan(
      PLAN_PRICES.business.monthly * 12,
    );
  });
});

describe('OVERAGE_RATES', () => {
  it('defines decision and search overage rates', () => {
    expect(OVERAGE_RATES.decision_cents).toBe(0.5);
    expect(OVERAGE_RATES.search_cents).toBe(0.2);
  });
});

// ---------------------------------------------------------------------------
// checkLimit — pure function tests
// ---------------------------------------------------------------------------

describe('checkLimit', () => {
  // Free tier
  describe('free tier', () => {
    it('allows store when under limit', () => {
      const result = checkLimit('free', 'decisions', 499);
      expect(result.allowed).toBe(true);
      expect(result.overage).toBe(false);
      expect(result.plan).toBe('free');
      expect(result.current).toBe(499);
      expect(result.limit).toBe(500);
    });

    it('blocks store at limit (500/500)', () => {
      const result = checkLimit('free', 'decisions', 500);
      expect(result.allowed).toBe(false);
      expect(result.overage).toBe(false);
    });

    it('blocks store above limit', () => {
      const result = checkLimit('free', 'decisions', 501);
      expect(result.allowed).toBe(false);
    });

    it('allows search when under limit', () => {
      const result = checkLimit('free', 'searches', 99);
      expect(result.allowed).toBe(true);
    });

    it('blocks search at limit (100/100)', () => {
      const result = checkLimit('free', 'searches', 100);
      expect(result.allowed).toBe(false);
    });

    it('allows members when under limit', () => {
      const result = checkLimit('free', 'members', 4);
      expect(result.allowed).toBe(true);
    });

    it('blocks members at limit', () => {
      const result = checkLimit('free', 'members', 5);
      expect(result.allowed).toBe(false);
    });
  });

  // Paid tier (team) — overage enabled
  describe('team tier (paid, overage enabled)', () => {
    it('allows store when under limit with no overage', () => {
      const result = checkLimit('team', 'decisions', 4_999);
      expect(result.allowed).toBe(true);
      expect(result.overage).toBe(false);
    });

    it('allows store at limit with overage flag', () => {
      const result = checkLimit('team', 'decisions', 5_000);
      expect(result.allowed).toBe(true);
      expect(result.overage).toBe(true);
    });

    it('allows store above limit with overage flag', () => {
      const result = checkLimit('team', 'decisions', 10_000);
      expect(result.allowed).toBe(true);
      expect(result.overage).toBe(true);
    });

    it('allows search at limit with overage', () => {
      const result = checkLimit('team', 'searches', 1_000);
      expect(result.allowed).toBe(true);
      expect(result.overage).toBe(true);
    });
  });

  // Business tier
  describe('business tier (paid, overage enabled)', () => {
    it('allows at limit with overage', () => {
      const result = checkLimit('business', 'decisions', 25_000);
      expect(result.allowed).toBe(true);
      expect(result.overage).toBe(true);
    });
  });

  // Enterprise — unlimited
  describe('enterprise tier', () => {
    it('always allows decisions (unlimited)', () => {
      const result = checkLimit('enterprise', 'decisions', 1_000_000);
      expect(result.allowed).toBe(true);
      expect(result.overage).toBe(false);
      expect(result.limit).toBe(Infinity);
    });

    it('always allows searches (unlimited)', () => {
      const result = checkLimit('enterprise', 'searches', 999_999);
      expect(result.allowed).toBe(true);
      expect(result.overage).toBe(false);
    });

    it('always allows members (unlimited)', () => {
      const result = checkLimit('enterprise', 'members', 500);
      expect(result.allowed).toBe(true);
    });
  });

  // Zero usage
  describe('zero usage', () => {
    it('allows all plans at zero usage', () => {
      for (const plan of ['free', 'team', 'business', 'enterprise'] as const) {
        const result = checkLimit(plan, 'decisions', 0);
        expect(result.allowed).toBe(true);
        expect(result.overage).toBe(false);
      }
    });
  });
});

// ---------------------------------------------------------------------------
// checkUsageOrProceed — fail-open tests
//
// We mock getToken at the module level via vi.mock (hoisted). Individual
// tests control the mock's return value via mockReturnValue/mockRejectedValue.
// ---------------------------------------------------------------------------

vi.mock('../../src/auth/jwt.js', () => {
  const getToken = vi.fn();
  return { getToken, exchangeToken: vi.fn(), refreshToken: vi.fn(), isJwtMode: vi.fn(), getAccessTokenFn: vi.fn(), clearTokenCache: vi.fn() };
});

import { checkUsageOrProceed } from '../../src/billing/usage.js';
import { getToken } from '../../src/auth/jwt.js';

const mockedGetToken = vi.mocked(getToken);

describe('checkUsageOrProceed (fail-open guarantee)', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
    globalThis.fetch = originalFetch;
  });

  afterAll(() => {
    globalThis.fetch = originalFetch;
  });

  it('returns allowed:true when getToken returns null (offline/auth failure)', async () => {
    mockedGetToken.mockResolvedValue(null);

    const result = await checkUsageOrProceed(
      'https://test.supabase.co',
      'tm_testkey',
      'org-123',
      'store',
    );

    // Fail-open: no token -> allowed
    expect(result.allowed).toBe(true);
  });

  it('returns allowed:true when fetch throws (network error / timeout)', async () => {
    mockedGetToken.mockResolvedValue({
      jwt: { token: 'test-jwt', expires_at: '2099-01-01T00:00:00Z' },
      member_id: 'm1',
      org_id: 'org-123',
      role: 'admin',
      author_name: 'tester',
    });

    globalThis.fetch = vi.fn().mockRejectedValue(new Error('Timeout'));

    const result = await checkUsageOrProceed(
      'https://test.supabase.co',
      'tm_testkey',
      'org-123',
      'search',
    );

    // Fail-open: timeout -> allowed
    expect(result.allowed).toBe(true);
  });

  it('returns allowed:true when Edge Function returns HTTP 500', async () => {
    mockedGetToken.mockResolvedValue({
      jwt: { token: 'test-jwt', expires_at: '2099-01-01T00:00:00Z' },
      member_id: 'm1',
      org_id: 'org-123',
      role: 'admin',
      author_name: 'tester',
    });

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: () => Promise.resolve({ error: 'internal' }),
    });

    const result = await checkUsageOrProceed(
      'https://test.supabase.co',
      'tm_testkey',
      'org-123',
      'store',
    );

    // Fail-open: HTTP error -> allowed
    expect(result.allowed).toBe(true);
  });

  it('returns denied when Edge Function says not allowed', async () => {
    mockedGetToken.mockResolvedValue({
      jwt: { token: 'test-jwt', expires_at: '2099-01-01T00:00:00Z' },
      member_id: 'm1',
      org_id: 'org-123',
      role: 'admin',
      author_name: 'tester',
    });

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          allowed: false,
          plan: 'free',
          reason: 'Free tier limit reached (500/500 decisions).',
          upgrade: {
            message: 'Upgrade to Team ($29/mo) for 5,000 decisions.',
            checkout_url: null,
          },
        }),
    });

    const result = await checkUsageOrProceed(
      'https://test.supabase.co',
      'tm_testkey',
      'org-123',
      'store',
    );

    expect(result.allowed).toBe(false);
    expect(result.message).toContain('Free tier limit reached');
    expect(result.plan).toBe('free');
  });

  it('returns allowed with overage when Edge Function returns overage', async () => {
    mockedGetToken.mockResolvedValue({
      jwt: { token: 'test-jwt', expires_at: '2099-01-01T00:00:00Z' },
      member_id: 'm1',
      org_id: 'org-123',
      role: 'admin',
      author_name: 'tester',
    });

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          allowed: true,
          plan: 'team',
          overage: true,
          overage_rate: '$0.005 per decision',
        }),
    });

    const result = await checkUsageOrProceed(
      'https://test.supabase.co',
      'tm_testkey',
      'org-123',
      'store',
    );

    expect(result.allowed).toBe(true);
    expect(result.overage).toBe(true);
    expect(result.plan).toBe('team');
  });
});
