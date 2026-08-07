/**
 * Regression guard: `getOrgInfo` must count decisions live.
 *
 * The `orgs.decision_count` column (supabase/migrations/001_init.sql) is never
 * incremented by any trigger or write path — every org in production read 0
 * while the `decisions` table held thousands of rows. `valis status` on
 * self-hosted installs therefore reported an empty brain.
 */
import { describe, it, expect, vi } from 'vitest';
import { getOrgInfo } from '../../src/cloud/supabase.js';

function makeMockClient(memberCount: number, decisionCount: number) {
  const from = vi.fn((table: string) => {
    if (table === 'orgs') {
      return {
        select: () => ({
          eq: () => ({
            // The column must NOT be selected — a stale 0 would silently win.
            single: async () => ({ data: { name: 'Acme' }, error: null }),
          }),
        }),
      };
    }
    if (table === 'members') {
      return { select: () => ({ eq: async () => ({ count: memberCount, error: null }) }) };
    }
    if (table === 'decisions') {
      return { select: () => ({ eq: async () => ({ count: decisionCount, error: null }) }) };
    }
    throw new Error(`unexpected table: ${table}`);
  });

  return { from } as never;
}

describe('getOrgInfo', () => {
  it('counts decisions from the decisions table, not orgs.decision_count', async () => {
    const supabase = makeMockClient(3, 3935);

    const info = await getOrgInfo(supabase, 'org-1');

    expect(info).not.toBeNull();
    expect(info!.name).toBe('Acme');
    expect(info!.member_count).toBe(3);
    expect(info!.decision_count).toBe(3935);
  });

  it('returns 0 decisions for an empty org without throwing', async () => {
    const supabase = makeMockClient(1, 0);

    const info = await getOrgInfo(supabase, 'org-2');

    expect(info!.decision_count).toBe(0);
  });
});
