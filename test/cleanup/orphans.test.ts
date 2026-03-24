/**
 * Unit tests for cleanup/orphans.ts
 *
 * T028: Tests stale pending identification, age calculation,
 * and empty result when no orphans exist.
 */

import { describe, it, expect, vi } from 'vitest';
import { findStaleOrphans } from '../../src/cleanup/orphans.js';

// ---------------------------------------------------------------------------
// Mock Supabase
// ---------------------------------------------------------------------------

function createMockSupabase(decisions: Record<string, unknown>[]) {
  const fromChain = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    lt: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnValue({ data: decisions, error: null }),
  };

  return {
    from: vi.fn().mockReturnValue(fromChain),
    _chain: fromChain,
  };
}

// ---------------------------------------------------------------------------
// Stale orphan detection
// ---------------------------------------------------------------------------

describe('findStaleOrphans', () => {
  it('identifies pending decisions older than 30 days', async () => {
    const fortyDaysAgo = new Date(Date.now() - 40 * 86_400_000).toISOString();
    const fiftyDaysAgo = new Date(Date.now() - 50 * 86_400_000).toISOString();

    const decisions = [
      { id: 'orphan-1', summary: 'Old pending', detail: 'Some text', created_at: fortyDaysAgo },
      { id: 'orphan-2', summary: null, detail: 'Another old one', created_at: fiftyDaysAgo },
    ];

    const supabase = createMockSupabase(decisions);
    const result = await findStaleOrphans(supabase as never, 'org-1', 30);

    expect(result).toHaveLength(2);

    // First orphan
    expect(result[0].decisionId).toBe('orphan-1');
    expect(result[0].summary).toBe('Old pending');
    expect(result[0].ageDays).toBeGreaterThanOrEqual(40);

    // Second orphan
    expect(result[1].decisionId).toBe('orphan-2');
    expect(result[1].summary).toBeNull();
    expect(result[1].ageDays).toBeGreaterThanOrEqual(50);
  });

  it('returns empty when no stale orphans exist', async () => {
    const supabase = createMockSupabase([]);
    const result = await findStaleOrphans(supabase as never, 'org-1', 30);
    expect(result).toHaveLength(0);
  });

  it('calculates age correctly', async () => {
    const exactlyThirtyOneDaysAgo = new Date(Date.now() - 31 * 86_400_000).toISOString();
    const decisions = [
      { id: 'orphan-1', summary: 'Edge case', detail: 'text', created_at: exactlyThirtyOneDaysAgo },
    ];

    const supabase = createMockSupabase(decisions);
    const result = await findStaleOrphans(supabase as never, 'org-1', 30);

    expect(result).toHaveLength(1);
    expect(result[0].ageDays).toBe(31);
  });

  it('respects custom staleDays parameter', async () => {
    // The mock always returns what we give it, so this tests that the function
    // passes through and processes the response correctly.
    const sixtyDaysAgo = new Date(Date.now() - 60 * 86_400_000).toISOString();
    const decisions = [
      { id: 'orphan-1', summary: 'Very old', detail: 'text', created_at: sixtyDaysAgo },
    ];

    const supabase = createMockSupabase(decisions);
    const result = await findStaleOrphans(supabase as never, 'org-1', 60);

    expect(result).toHaveLength(1);
    expect(result[0].ageDays).toBeGreaterThanOrEqual(60);
  });

  it('preserves detail field in output', async () => {
    const fortyDaysAgo = new Date(Date.now() - 40 * 86_400_000).toISOString();
    const decisions = [
      { id: 'orphan-1', summary: 'With detail', detail: 'Full detail text here', created_at: fortyDaysAgo },
    ];

    const supabase = createMockSupabase(decisions);
    const result = await findStaleOrphans(supabase as never, 'org-1', 30);

    expect(result).toHaveLength(1);
    expect(result[0].detail).toBe('Full detail text here');
  });

  it('throws on supabase error', async () => {
    const fromChain = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      lt: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnValue({ data: null, error: { message: 'DB error' } }),
    };

    const supabase = {
      from: vi.fn().mockReturnValue(fromChain),
    };

    await expect(findStaleOrphans(supabase as never, 'org-1', 30)).rejects.toThrow(
      'Failed to fetch stale orphans: DB error',
    );
  });
});
