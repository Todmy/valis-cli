import { describe, it, expect } from 'vitest';
import {
  PLAN_LIMITS,
  PLAN_PRICES,
  OVERAGE_RATES,
  checkLimit,
} from '../../src/billing/limits.js';
import type { PlanTier } from '../../src/types.js';

// ---------------------------------------------------------------------------
// T075: Unit tests for billing limits
// - Free tier block
// - Paid overage tracking
// - Enterprise unlimited
// - Fail-open on error (tested in usage.test.ts)
// ---------------------------------------------------------------------------

describe('PLAN_LIMITS constants', () => {
  it('defines limits for all four plan tiers', () => {
    const tiers: PlanTier[] = ['free', 'team', 'business', 'enterprise'];
    for (const tier of tiers) {
      expect(PLAN_LIMITS[tier]).toBeDefined();
      expect(typeof PLAN_LIMITS[tier].decisions).toBe('number');
      expect(typeof PLAN_LIMITS[tier].members).toBe('number');
      expect(typeof PLAN_LIMITS[tier].searches).toBe('number');
      expect(typeof PLAN_LIMITS[tier].overage).toBe('boolean');
    }
  });

  it('free tier has no overage', () => {
    expect(PLAN_LIMITS.free.overage).toBe(false);
  });

  it('team tier allows overage', () => {
    expect(PLAN_LIMITS.team.overage).toBe(true);
  });

  it('business tier allows overage', () => {
    expect(PLAN_LIMITS.business.overage).toBe(true);
  });

  it('enterprise tier has unlimited everything', () => {
    expect(PLAN_LIMITS.enterprise.decisions).toBe(Infinity);
    expect(PLAN_LIMITS.enterprise.members).toBe(Infinity);
    expect(PLAN_LIMITS.enterprise.searches).toBe(Infinity);
  });

  it('enterprise tier has no overage (unlimited = no overage needed)', () => {
    expect(PLAN_LIMITS.enterprise.overage).toBe(false);
  });

  it('free < team < business for all limits', () => {
    expect(PLAN_LIMITS.free.decisions).toBeLessThan(PLAN_LIMITS.team.decisions);
    expect(PLAN_LIMITS.team.decisions).toBeLessThan(PLAN_LIMITS.business.decisions);
    expect(PLAN_LIMITS.free.members).toBeLessThan(PLAN_LIMITS.team.members);
    expect(PLAN_LIMITS.team.members).toBeLessThan(PLAN_LIMITS.business.members);
    expect(PLAN_LIMITS.free.searches).toBeLessThan(PLAN_LIMITS.team.searches);
    expect(PLAN_LIMITS.team.searches).toBeLessThan(PLAN_LIMITS.business.searches);
  });
});

describe('PLAN_PRICES', () => {
  it('defines prices for team and business', () => {
    expect(PLAN_PRICES.team.monthly).toBeGreaterThan(0);
    expect(PLAN_PRICES.team.annual).toBeGreaterThan(0);
    expect(PLAN_PRICES.business.monthly).toBeGreaterThan(0);
    expect(PLAN_PRICES.business.annual).toBeGreaterThan(0);
  });

  it('annual is cheaper per month than monthly', () => {
    // Annual price / 12 should be less than monthly
    expect(PLAN_PRICES.team.annual / 12).toBeLessThan(PLAN_PRICES.team.monthly);
    expect(PLAN_PRICES.business.annual / 12).toBeLessThan(PLAN_PRICES.business.monthly);
  });
});

describe('OVERAGE_RATES', () => {
  it('has positive rates', () => {
    expect(OVERAGE_RATES.decision_cents).toBeGreaterThan(0);
    expect(OVERAGE_RATES.search_cents).toBeGreaterThan(0);
  });
});

describe('checkLimit', () => {
  describe('free tier', () => {
    it('allows operations within limit', () => {
      const result = checkLimit('free', 'decisions', 0);
      expect(result.allowed).toBe(true);
      expect(result.overage).toBe(false);
      expect(result.plan).toBe('free');
    });

    it('allows operations at limit minus one', () => {
      const result = checkLimit('free', 'decisions', PLAN_LIMITS.free.decisions - 1);
      expect(result.allowed).toBe(true);
    });

    it('blocks operations at limit', () => {
      const result = checkLimit('free', 'decisions', PLAN_LIMITS.free.decisions);
      expect(result.allowed).toBe(false);
      expect(result.overage).toBe(false);
    });

    it('blocks operations above limit', () => {
      const result = checkLimit('free', 'decisions', PLAN_LIMITS.free.decisions + 100);
      expect(result.allowed).toBe(false);
    });

    it('blocks search when daily limit reached', () => {
      const result = checkLimit('free', 'searches', PLAN_LIMITS.free.searches);
      expect(result.allowed).toBe(false);
    });

    it('blocks members when limit reached', () => {
      const result = checkLimit('free', 'members', PLAN_LIMITS.free.members);
      expect(result.allowed).toBe(false);
    });
  });

  describe('team tier (paid, overage enabled)', () => {
    it('allows operations within limit without overage', () => {
      const result = checkLimit('team', 'decisions', 100);
      expect(result.allowed).toBe(true);
      expect(result.overage).toBe(false);
    });

    it('allows operations at limit with overage flag', () => {
      const result = checkLimit('team', 'decisions', PLAN_LIMITS.team.decisions);
      expect(result.allowed).toBe(true);
      expect(result.overage).toBe(true);
    });

    it('allows operations above limit with overage flag', () => {
      const result = checkLimit('team', 'decisions', PLAN_LIMITS.team.decisions + 500);
      expect(result.allowed).toBe(true);
      expect(result.overage).toBe(true);
    });

    it('allows searches above limit with overage', () => {
      const result = checkLimit('team', 'searches', PLAN_LIMITS.team.searches + 100);
      expect(result.allowed).toBe(true);
      expect(result.overage).toBe(true);
    });
  });

  describe('business tier (paid, overage enabled)', () => {
    it('allows within limit', () => {
      const result = checkLimit('business', 'decisions', 1000);
      expect(result.allowed).toBe(true);
      expect(result.overage).toBe(false);
    });

    it('allows above limit with overage', () => {
      const result = checkLimit('business', 'decisions', PLAN_LIMITS.business.decisions + 1);
      expect(result.allowed).toBe(true);
      expect(result.overage).toBe(true);
    });
  });

  describe('enterprise tier (unlimited)', () => {
    it('always allows decisions', () => {
      const result = checkLimit('enterprise', 'decisions', 1_000_000);
      expect(result.allowed).toBe(true);
      expect(result.overage).toBe(false);
    });

    it('always allows searches', () => {
      const result = checkLimit('enterprise', 'searches', 999_999);
      expect(result.allowed).toBe(true);
      expect(result.overage).toBe(false);
    });

    it('always allows members', () => {
      const result = checkLimit('enterprise', 'members', 10_000);
      expect(result.allowed).toBe(true);
      expect(result.overage).toBe(false);
    });

    it('has Infinity as limit value', () => {
      const result = checkLimit('enterprise', 'decisions', 0);
      expect(result.limit).toBe(Infinity);
    });
  });

  describe('result metadata', () => {
    it('returns current usage count', () => {
      const result = checkLimit('free', 'decisions', 42);
      expect(result.current).toBe(42);
    });

    it('returns plan limit', () => {
      const result = checkLimit('free', 'decisions', 0);
      expect(result.limit).toBe(PLAN_LIMITS.free.decisions);
    });

    it('returns plan tier', () => {
      const result = checkLimit('team', 'decisions', 0);
      expect(result.plan).toBe('team');
    });
  });
});
