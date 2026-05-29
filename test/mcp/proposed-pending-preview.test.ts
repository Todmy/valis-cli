/**
 * 040/#226 US3 — top_3 preview shape + ordering (OQ-1: oldest-first,
 * `created_at ASC`). Asserts ≤3 entries, no padding, correct shape, and
 * `similarity` semantics: a score when the draft id is in the supplied
 * `similarityById` map, `null` otherwise (metadata-only path — FR-004).
 *
 * finding #7 — the mock no longer echoes a pre-sorted fixture. It seeds rows in
 * SCRAMBLED order, each with a distinct `created_at`, and the preview terminal
 * APPLIES the `ascending` flag the helper actually passed to `.order(...)`.
 * So the asserted output order is produced by the helper's ordering request,
 * not hand-fed — flipping the helper to `created_desc` would change the result.
 *
 * finding #1 — a legacy `type='pending'` preview row must surface as
 * `type: 'decision'` so the top_3 label agrees with the by_type bucket it was
 * counted in.
 */

import { describe, it, expect, vi } from 'vitest';
import { countProposedPending } from '../../src/cloud/supabase/proposed-pending.js';
import type { SupabaseClient } from '@supabase/supabase-js';

interface SeedRow {
  id: string;
  type: string;
  summary: string;
  created_at: string;
}

/**
 * Mock client whose preview terminal sorts the seeded rows by `created_at`
 * using the `ascending` flag captured from the helper's `.order(...)` call,
 * then truncates to the limit. The COUNT terminal returns `total`.
 */
function makeClient(seedRows: SeedRow[], total: number) {
  let capturedAscending: boolean | undefined;
  function builder() {
    const chain: Record<string, unknown> = {};
    const ret = () => chain;
    chain.select = () => ret();
    chain.eq = () => ret();
    chain.or = () => ret();
    chain.in = () => ret();
    chain.order = (_col: string, opt?: { ascending?: boolean }) => {
      capturedAscending = opt?.ascending;
      return ret();
    };
    chain.limit = (n: number) => {
      // Apply the helper-requested ordering against created_at. If the helper
      // stops requesting created_at ASC, this output order changes.
      const asc = capturedAscending !== false;
      const sorted = [...seedRows].sort((a, b) =>
        asc ? a.created_at.localeCompare(b.created_at) : b.created_at.localeCompare(a.created_at),
      );
      return Promise.resolve({
        data: sorted.slice(0, n).map((r) => ({ id: r.id, type: r.type, summary: r.summary })),
        error: null,
        count: null,
      });
    };
    chain.then = (resolve: (v: unknown) => void) =>
      resolve({ count: total, data: null, error: null });
    return chain;
  }
  return {
    client: { from: vi.fn(() => builder()) } as unknown as SupabaseClient,
    getAscending: () => capturedAscending,
  };
}

// Deliberately scrambled insertion order — created_at is the only ordering key.
const SCRAMBLED: SeedRow[] = [
  { id: 'middle', type: 'lesson', summary: 'middle draft', created_at: '2026-03-02T00:00:00Z' },
  { id: 'newest', type: 'decision', summary: 'newest of the three', created_at: '2026-03-03T00:00:00Z' },
  { id: 'oldest', type: 'constraint', summary: 'stalest draft', created_at: '2026-03-01T00:00:00Z' },
];

describe('countProposedPending — top_3 preview (US3)', () => {
  it('returns exactly 3 entries when >3 drafts exist, each with the full shape', async () => {
    const { client } = makeClient(SCRAMBLED, 5);
    const block = await countProposedPending(client, { orgId: 'o', projectId: 'p' });
    expect(block!.top_3).toHaveLength(3);
    for (const e of block!.top_3) {
      expect(e).toHaveProperty('id');
      expect(e).toHaveProperty('type');
      expect(e).toHaveProperty('summary');
      expect(e).toHaveProperty('similarity');
    }
  });

  it('requests created_at ASC AND the resulting order is oldest-first per OQ-1 (finding #7)', async () => {
    const { client, getAscending } = makeClient(SCRAMBLED, 5);
    const block = await countProposedPending(client, { orgId: 'o', projectId: 'p' });
    // The helper requested ascending ordering...
    expect(getAscending()).toBe(true);
    // ...and the output, sorted by created_at per that request, is oldest-first.
    // (The fixture was scrambled, so this order is produced, not echoed.)
    expect(block!.top_3.map((e) => e.id)).toEqual(['oldest', 'middle', 'newest']);
  });

  it('normalizes a legacy type=pending preview row to decision (finding #1)', async () => {
    const seed: SeedRow[] = [
      { id: 'legacy', type: 'pending', summary: 'legacy pending draft', created_at: '2026-03-01T00:00:00Z' },
      { id: 'normal', type: 'constraint', summary: 'a constraint draft', created_at: '2026-03-02T00:00:00Z' },
    ];
    const { client } = makeClient(seed, 2);
    const block = await countProposedPending(client, { orgId: 'o', projectId: 'p' });
    const byId = Object.fromEntries(block!.top_3.map((e) => [e.id, e.type]));
    // The pending row is counted in the decision bucket, so its label MUST read
    // 'decision' — never the raw 'pending' value (which would disagree with the
    // by_type partition).
    expect(byId['legacy']).toBe('decision');
    expect(byId['normal']).toBe('constraint');
  });

  it('does not pad: 2 drafts → exactly 2 entries', async () => {
    const { client } = makeClient(SCRAMBLED.slice(0, 2), 2);
    const block = await countProposedPending(client, { orgId: 'o', projectId: 'p' });
    expect(block!.top_3).toHaveLength(2);
  });

  it('similarity is null for every entry when no score map is supplied (metadata-only path)', async () => {
    const { client } = makeClient(SCRAMBLED, 3);
    const block = await countProposedPending(client, { orgId: 'o', projectId: 'p' });
    expect(block!.top_3.every((e) => e.similarity === null)).toBe(true);
  });

  it('attaches a similarity score only for previewed ids present in the map (FR-010 — no new embedding call)', async () => {
    const { client } = makeClient(SCRAMBLED, 3);
    const similarityById = new Map<string, number>([
      ['middle', 0.72],
      ['absent', 0.99], // not in preview — must not leak in
    ]);
    const block = await countProposedPending(
      client,
      { orgId: 'o', projectId: 'p' },
      { similarityById },
    );
    const byId = Object.fromEntries(block!.top_3.map((e) => [e.id, e.similarity]));
    expect(byId['middle']).toBe(0.72);
    expect(byId['oldest']).toBeNull();
    expect(byId['newest']).toBeNull();
  });
});
