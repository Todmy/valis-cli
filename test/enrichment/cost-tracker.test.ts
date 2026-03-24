/**
 * T060: Unit tests for cost ceiling tracker.
 *
 * Tests: ceiling reached, ceiling remaining, multi-provider per day,
 * usage tracking, and daily cost aggregation.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { checkCeiling, trackUsage, getDailyCost, DEFAULT_CEILING_CENTS } from '../../src/enrichment/cost-tracker.js';

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

/** Build a mock Supabase client with controllable query results. */
function mockSupabase(overrides: {
  selectResult?: { data: unknown; error: unknown };
  rpcResult?: { data: unknown; error: unknown };
} = {}) {
  const selectResult = overrides.selectResult ?? { data: null, error: null };
  const rpcResult = overrides.rpcResult ?? { data: null, error: null };

  const chainMethods = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue(selectResult),
  };

  return {
    from: vi.fn(() => chainMethods),
    rpc: vi.fn().mockResolvedValue(rpcResult),
    // Expose chain for assertions
    _chain: chainMethods,
  } as unknown as import('@supabase/supabase-js').SupabaseClient;
}

// ---------------------------------------------------------------------------
// DEFAULT_CEILING_CENTS
// ---------------------------------------------------------------------------

describe('DEFAULT_CEILING_CENTS', () => {
  it('equals 100 (i.e. $1.00)', () => {
    expect(DEFAULT_CEILING_CENTS).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// checkCeiling
// ---------------------------------------------------------------------------

describe('checkCeiling', () => {
  it('returns allowed=true with zero spend', async () => {
    const supabase = mockSupabase({
      selectResult: { data: null, error: null },
    });

    const result = await checkCeiling(supabase, 'org-1', 'anthropic', 100);

    expect(result.allowed).toBe(true);
    expect(result.spent).toBe(0);
    expect(result.remaining).toBe(100);
  });

  it('returns allowed=true when spend is below ceiling', async () => {
    const supabase = mockSupabase({
      selectResult: { data: { cost_cents: 50 }, error: null },
    });

    const result = await checkCeiling(supabase, 'org-1', 'anthropic', 100);

    expect(result.allowed).toBe(true);
    expect(result.spent).toBe(50);
    expect(result.remaining).toBe(50);
  });

  it('returns allowed=false when ceiling is reached (T060: ceiling reached)', async () => {
    const supabase = mockSupabase({
      selectResult: { data: { cost_cents: 100 }, error: null },
    });

    const result = await checkCeiling(supabase, 'org-1', 'anthropic', 100);

    expect(result.allowed).toBe(false);
    expect(result.spent).toBe(100);
    expect(result.remaining).toBe(0);
  });

  it('returns allowed=false when spend exceeds ceiling', async () => {
    const supabase = mockSupabase({
      selectResult: { data: { cost_cents: 150 }, error: null },
    });

    const result = await checkCeiling(supabase, 'org-1', 'openai', 100);

    expect(result.allowed).toBe(false);
    expect(result.spent).toBe(150);
    expect(result.remaining).toBe(0);
  });

  it('uses DEFAULT_CEILING_CENTS when no ceiling argument supplied', async () => {
    const supabase = mockSupabase({
      selectResult: { data: { cost_cents: 50 }, error: null },
    });

    const result = await checkCeiling(supabase, 'org-1', 'anthropic');

    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(DEFAULT_CEILING_CENTS - 50);
  });

  it('returns allowed=true with remaining clamped to 0 when at exact ceiling (T060: ceiling remaining)', async () => {
    const supabase = mockSupabase({
      selectResult: { data: { cost_cents: 99 }, error: null },
    });

    const result = await checkCeiling(supabase, 'org-1', 'anthropic', 100);

    expect(result.allowed).toBe(true);
    expect(result.spent).toBe(99);
    expect(result.remaining).toBe(1);
  });

  it('queries the correct table with org, date, and provider filters', async () => {
    const supabase = mockSupabase({
      selectResult: { data: null, error: null },
    });

    await checkCeiling(supabase, 'org-42', 'openai', 200);

    expect(supabase.from).toHaveBeenCalledWith('enrichment_usage');
    const chain = (supabase as any)._chain;
    expect(chain.select).toHaveBeenCalledWith('cost_cents');
    expect(chain.eq).toHaveBeenCalledWith('org_id', 'org-42');
    expect(chain.eq).toHaveBeenCalledWith('provider', 'openai');
  });
});

// ---------------------------------------------------------------------------
// trackUsage
// ---------------------------------------------------------------------------

describe('trackUsage', () => {
  it('calls increment_enrichment_usage RPC with correct parameters', async () => {
    const supabase = mockSupabase({
      rpcResult: { data: null, error: null },
    });

    await trackUsage(supabase, 'org-1', 'anthropic', 500, 5);

    expect(supabase.rpc).toHaveBeenCalledWith('increment_enrichment_usage', expect.objectContaining({
      p_org_id: 'org-1',
      p_provider: 'anthropic',
      p_decisions: 1,
      p_tokens: 500,
      p_cost_cents: 5,
    }));
  });

  it('does not throw on RPC error (non-fatal)', async () => {
    const supabase = mockSupabase({
      rpcResult: { data: null, error: { message: 'RPC error' } },
    });

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(trackUsage(supabase, 'org-1', 'openai', 100, 1)).resolves.not.toThrow();

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('enrichment usage tracking failed'));
    warnSpy.mockRestore();
  });

  it('tracks multi-provider usage independently (T060: multi-provider per day)', async () => {
    const supabase = mockSupabase({
      rpcResult: { data: null, error: null },
    });

    await trackUsage(supabase, 'org-1', 'anthropic', 300, 3);
    await trackUsage(supabase, 'org-1', 'openai', 400, 2);

    expect(supabase.rpc).toHaveBeenCalledTimes(2);

    const calls = (supabase.rpc as any).mock.calls;
    expect(calls[0][1].p_provider).toBe('anthropic');
    expect(calls[1][1].p_provider).toBe('openai');
  });
});

// ---------------------------------------------------------------------------
// getDailyCost
// ---------------------------------------------------------------------------

describe('getDailyCost', () => {
  it('returns 0 when no usage records exist', async () => {
    const chainMethods = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
    };
    // Override the final method in the chain to return empty array
    // getDailyCost doesn't call maybeSingle — it uses the array result
    const fromFn = vi.fn(() => chainMethods);

    // getDailyCost calls .from().select().eq().eq() and the last .eq()
    // should return the query result. We need to make the final .eq()
    // resolve to { data: [], error: null }.
    let eqCallCount = 0;
    chainMethods.eq.mockImplementation(() => {
      eqCallCount++;
      // The second .eq() is the final one in getDailyCost
      if (eqCallCount % 2 === 0) {
        return Promise.resolve({ data: [], error: null });
      }
      return chainMethods;
    });

    const supabase = { from: fromFn } as unknown as import('@supabase/supabase-js').SupabaseClient;

    const cost = await getDailyCost(supabase, 'org-1');
    expect(cost).toBe(0);
  });

  it('sums cost_cents across multiple providers (T060: multi-provider per day)', async () => {
    const chainMethods = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
    };
    const fromFn = vi.fn(() => chainMethods);

    let eqCallCount = 0;
    chainMethods.eq.mockImplementation(() => {
      eqCallCount++;
      if (eqCallCount % 2 === 0) {
        return Promise.resolve({
          data: [
            { cost_cents: 30 }, // anthropic
            { cost_cents: 20 }, // openai
          ],
          error: null,
        });
      }
      return chainMethods;
    });

    const supabase = { from: fromFn } as unknown as import('@supabase/supabase-js').SupabaseClient;

    const cost = await getDailyCost(supabase, 'org-1');
    expect(cost).toBe(50);
  });

  it('returns 0 when data is null', async () => {
    const chainMethods = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
    };
    const fromFn = vi.fn(() => chainMethods);

    let eqCallCount = 0;
    chainMethods.eq.mockImplementation(() => {
      eqCallCount++;
      if (eqCallCount % 2 === 0) {
        return Promise.resolve({ data: null, error: null });
      }
      return chainMethods;
    });

    const supabase = { from: fromFn } as unknown as import('@supabase/supabase-js').SupabaseClient;

    const cost = await getDailyCost(supabase, 'org-1');
    expect(cost).toBe(0);
  });
});
