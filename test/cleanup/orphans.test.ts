/**
 * Unit tests for orphan detection — T028 (US3)
 *
 * Tests stale pending identification, age calculation, and empty results.
 */

import { describe, it, expect, vi } from 'vitest';
import { findStaleOrphans } from '../../src/cleanup/orphans.js';

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function createMockSupabase(decisions: Record<string, unknown>[]) {
  return {
    from: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnThis(),
        lt: vi.fn().mockReturnThis(),
        order: vi.fn().mockReturnValue({
          data: decisions,
          error: null,
        }),
      }),
    }),
  } as unknown as import('@supabase/supabase-js').SupabaseClient;
}

function createErrorSupabase(message: string) {
  return {
    from: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnThis(),
        lt: vi.fn().mockReturnThis(),
        order: vi.fn().mockReturnValue({
          data: null,
          error: { message },
        }),
      }),
    }),
  } as unknown as import('@supabase/supabase-js').SupabaseClient;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Orphan Detection', () => {
  it('identifies stale pending decisions older than 30 days', async () => {
    const fortyDaysAgo = new Date(
      Date.now() - 40 * 86_400_000,
    ).toISOString();

    const decisions = [
      {
        id: 'orphan-1',
        summary: 'Old pending decision',
        detail: 'Some detail text',
        created_at: fortyDaysAgo,
      },
    ];

    const supabase = createMockSupabase(decisions);
    const result = await findStaleOrphans(supabase, 'org-1', 30);

    expect(result).toHaveLength(1);
    expect(result[0].decisionId).toBe('orphan-1');
    expect(result[0].summary).toBe('Old pending decision');
    expect(result[0].detail).toBe('Some detail text');
    expect(result[0].ageDays).toBeGreaterThanOrEqual(40);
  });

  it('calculates age correctly for multiple orphans', async () => {
    const sixtyDaysAgo = new Date(
      Date.now() - 60 * 86_400_000,
    ).toISOString();
    const fortyFiveDaysAgo = new Date(
      Date.now() - 45 * 86_400_000,
    ).toISOString();

    const decisions = [
      {
        id: 'old-orphan',
        summary: null,
        detail: 'Very old pending',
        created_at: sixtyDaysAgo,
      },
      {
        id: 'recent-orphan',
        summary: 'Newer orphan',
        detail: 'Less old pending',
        created_at: fortyFiveDaysAgo,
      },
    ];

    const supabase = createMockSupabase(decisions);
    const result = await findStaleOrphans(supabase, 'org-1', 30);

    expect(result).toHaveLength(2);

    const oldOrphan = result.find((o) => o.decisionId === 'old-orphan');
    const recentOrphan = result.find((o) => o.decisionId === 'recent-orphan');

    expect(oldOrphan).toBeDefined();
    expect(oldOrphan!.ageDays).toBeGreaterThanOrEqual(60);
    expect(oldOrphan!.summary).toBeNull();

    expect(recentOrphan).toBeDefined();
    expect(recentOrphan!.ageDays).toBeGreaterThanOrEqual(45);
    expect(recentOrphan!.ageDays).toBeLessThan(60);
  });

  it('returns empty array when no orphans exist', async () => {
    const supabase = createMockSupabase([]);
    const result = await findStaleOrphans(supabase, 'org-1', 30);
    expect(result).toEqual([]);
  });

  it('returns empty array when data is null', async () => {
    const supabase = {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnThis(),
          lt: vi.fn().mockReturnThis(),
          order: vi.fn().mockReturnValue({
            data: null,
            error: null,
          }),
        }),
      }),
    } as unknown as import('@supabase/supabase-js').SupabaseClient;

    const result = await findStaleOrphans(supabase, 'org-1', 30);
    expect(result).toEqual([]);
  });

  it('respects custom staleDays parameter', async () => {
    const tenDaysAgo = new Date(Date.now() - 10 * 86_400_000).toISOString();

    const decisions = [
      {
        id: 'stale-7',
        summary: 'Stale after 7 days',
        detail: 'Detail',
        created_at: tenDaysAgo,
      },
    ];

    const supabase = createMockSupabase(decisions);
    // Use 7 days instead of default 30
    const result = await findStaleOrphans(supabase, 'org-1', 7);

    expect(result).toHaveLength(1);
    expect(result[0].ageDays).toBeGreaterThanOrEqual(10);
  });

  it('throws on Supabase error', async () => {
    const supabase = createErrorSupabase('connection failed');

    await expect(
      findStaleOrphans(supabase, 'org-1', 30),
    ).rejects.toThrow('Failed to fetch stale orphans: connection failed');
  });

  it('handles decisions with null summary', async () => {
    const fortyDaysAgo = new Date(
      Date.now() - 40 * 86_400_000,
    ).toISOString();

    const decisions = [
      {
        id: 'no-summary',
        summary: null,
        detail: 'Pending without summary',
        created_at: fortyDaysAgo,
      },
    ];

    const supabase = createMockSupabase(decisions);
    const result = await findStaleOrphans(supabase, 'org-1', 30);

    expect(result).toHaveLength(1);
    expect(result[0].summary).toBeNull();
    expect(result[0].detail).toBe('Pending without summary');
  });
});
