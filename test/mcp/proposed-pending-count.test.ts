/**
 * 040/#226 — THE critical regression test (SC-001, lesson `104083be`).
 *
 * Seeds MORE proposed rows than PostgREST's `db-max-rows` ceiling (default
 * 1000) and asserts the helper reports the EXACT count. The mock models the
 * real failure mode: a `head: true` exact COUNT returns `{ count: N, data: null }`
 * (no rows transferred), whereas a plain `select()` would return at most
 * `db-max-rows` rows. If any code path computed `count` via `.length` over the
 * fetched set it would undercount to the cap and this test would fail.
 *
 * Also covers US2 (by_type partitions count) as a property over random mixes.
 */

import { describe, it, expect, vi } from 'vitest';
import { countProposedPending } from '../../src/cloud/supabase/proposed-pending.js';
import type { SupabaseClient } from '@supabase/supabase-js';

const DB_MAX_ROWS = 1000;

interface MockOpts {
  total: number;
  byType: { decision: number; pattern: number; lesson: number; constraint: number };
  previewRows: Array<{ id: string; type: string; summary: string }>;
}

/**
 * Mock Supabase client. Each `.from('decisions')` returns a fresh chainable
 * builder. The terminal value depends on which query the helper composed:
 *   - `.in('type', [...])`  → decision bucket count
 *   - `.eq('type', X)`      → that type's count
 *   - neither (head COUNT)  → total
 *   - `.limit(n)`           → bounded preview fetch (≤n rows)
 * COUNT calls always resolve `{ count, data: null }` — never a row array — so a
 * `.length`-based count would read 0/undefined, not the true total.
 */
function makeMockClient(opts: MockOpts): SupabaseClient {
  function builder() {
    const state: { isDecisionBucket: boolean; typeEq?: keyof MockOpts['byType'] } = {
      isDecisionBucket: false,
    };
    const chain: Record<string, unknown> = {};
    const ret = () => chain;
    chain.select = () => ret();
    chain.eq = (col: string, val: unknown) => {
      if (col === 'type') state.typeEq = val as keyof MockOpts['byType'];
      return ret();
    };
    chain.or = () => ret();
    chain.in = () => {
      state.isDecisionBucket = true;
      return ret();
    };
    chain.order = () => ret();
    chain.limit = (n: number) =>
      Promise.resolve({ data: opts.previewRows.slice(0, n), error: null, count: null });
    chain.then = (resolve: (v: unknown) => void) => {
      let count: number;
      if (state.isDecisionBucket) count = opts.byType.decision;
      else if (state.typeEq) count = opts.byType[state.typeEq];
      else count = opts.total;
      resolve({ count, data: null, error: null });
    };
    return chain;
  }
  return { from: vi.fn(() => builder()) } as unknown as SupabaseClient;
}

describe('countProposedPending — truncation-proof exact COUNT (SC-001, lesson 104083be)', () => {
  it('reports the exact count even when it far exceeds db-max-rows', async () => {
    const total = DB_MAX_ROWS + 500; // 1500 — above the PostgREST cap
    const client = makeMockClient({
      total,
      byType: { decision: total, pattern: 0, lesson: 0, constraint: 0 },
      previewRows: [
        { id: 'd1', type: 'decision', summary: 'oldest draft' },
        { id: 'd2', type: 'decision', summary: 'second' },
        { id: 'd3', type: 'decision', summary: 'third' },
      ],
    });
    const block = await countProposedPending(client, { orgId: 'org-1', projectId: 'proj-1' });
    expect(block).not.toBeNull();
    expect(block!.count).toBe(total);
    // Proves no truncation: count is NOT clamped to the db-max-rows cap.
    expect(block!.count).toBeGreaterThan(DB_MAX_ROWS);
  });

  it('by_type partitions the REAL draft predicate — each bucket COUNT applies the actual filter the helper composed (SC-002, finding #6)', async () => {
    // Model the database as a concrete set of decision rows. The draft predicate
    // is `status='proposed' OR type='pending'`. The mock REPLAYS the exact
    // filters the helper composes (`.eq('org_id')`, `.eq('project_id')`,
    // `.or(predicate)`, and the per-bucket `.in('type',[...])`/`.eq('type')`)
    // against this set and returns `rows.filter(...).length` as the COUNT.
    //
    // This is NOT true-by-construction: if the helper dropped the `.or` draft
    // predicate, scoped to the wrong project, or stopped folding `type='pending'`
    // into the decision bucket, the replayed COUNT would diverge from the
    // hand-computed expectation below and the test would fail.
    interface Row {
      org_id: string;
      project_id: string;
      status: string;
      type: string;
    }
    const ORG = 'org-1';
    const PROJ = 'proj-1';
    const rows: Row[] = [
      // proposed drafts of each type (in scope)
      { org_id: ORG, project_id: PROJ, status: 'proposed', type: 'decision' },
      { org_id: ORG, project_id: PROJ, status: 'proposed', type: 'decision' },
      { org_id: ORG, project_id: PROJ, status: 'proposed', type: 'pattern' },
      { org_id: ORG, project_id: PROJ, status: 'proposed', type: 'lesson' },
      { org_id: ORG, project_id: PROJ, status: 'proposed', type: 'constraint' },
      // legacy `type='pending'` draft — MUST fold into the decision bucket (finding #1)
      { org_id: ORG, project_id: PROJ, status: 'active', type: 'pending' },
      // active non-draft decision — excluded by the draft predicate
      { org_id: ORG, project_id: PROJ, status: 'active', type: 'decision' },
      // other project, same org — excluded by project_id scope
      { org_id: ORG, project_id: 'other-proj', status: 'proposed', type: 'decision' },
      // other org — excluded by org_id scope
      { org_id: 'other-org', project_id: PROJ, status: 'proposed', type: 'lesson' },
    ];

    // Predicate replay: a row is a draft when status='proposed' OR type='pending'.
    const isDraft = (r: Row) => r.status === 'proposed' || r.type === 'pending';

    // Build a client whose COUNT terminal counts rows matching the composed
    // filters. The builder records: org_id eq, project_id eq, whether `.or`
    // (draft predicate) was applied, an `.in('type', list)` set, and an
    // `.eq('type', x)` value.
    const replayClient = {
      from: vi.fn(() => {
        const f: {
          orgId?: string;
          projectId?: string;
          draft: boolean;
          inTypes?: string[];
          eqType?: string;
        } = { draft: false };
        const chain: Record<string, unknown> = {};
        const ret = () => chain;
        chain.select = () => ret();
        chain.eq = (col: string, val: string) => {
          if (col === 'org_id') f.orgId = val;
          else if (col === 'project_id') f.projectId = val;
          else if (col === 'type') f.eqType = val;
          return ret();
        };
        chain.or = () => {
          f.draft = true;
          return ret();
        };
        chain.in = (col: string, list: string[]) => {
          if (col === 'type') f.inTypes = list;
          return ret();
        };
        chain.order = () => ret();
        const matches = (r: Row) => {
          if (f.orgId !== undefined && r.org_id !== f.orgId) return false;
          if (f.projectId !== undefined && r.project_id !== f.projectId) return false;
          if (f.draft && !isDraft(r)) return false;
          if (f.inTypes && !f.inTypes.includes(r.type)) return false;
          if (f.eqType !== undefined && r.type !== f.eqType) return false;
          return true;
        };
        chain.limit = (n: number) =>
          Promise.resolve({
            data: rows
              .filter(matches)
              .slice(0, n)
              .map((r, i) => ({ id: `row-${i}`, type: r.type, summary: '' })),
            error: null,
            count: null,
          });
        chain.then = (resolve: (v: unknown) => void) =>
          resolve({ count: rows.filter(matches).length, data: null, error: null });
        return chain;
      }),
    } as unknown as SupabaseClient;

    const block = await countProposedPending(replayClient, { orgId: ORG, projectId: PROJ });
    expect(block).not.toBeNull();

    // Hand-computed expectations from the seeded set, in scope (org+project) and
    // matching the draft predicate:
    //   decision bucket = 2 proposed-decision + 1 pending = 3
    //   pattern = 1, lesson = 1, constraint = 1
    expect(block!.by_type.decision).toBe(3);
    expect(block!.by_type.pattern).toBe(1);
    expect(block!.by_type.lesson).toBe(1);
    expect(block!.by_type.constraint).toBe(1);
    // Derived total = sum of buckets = 6 (finding #3) — and equals the number of
    // in-scope draft rows, proving the four buckets partition the predicate.
    expect(block!.count).toBe(6);
    expect(
      block!.by_type.decision +
        block!.by_type.pattern +
        block!.by_type.lesson +
        block!.by_type.constraint,
    ).toBe(block!.count);
  });

  it('returns null on a COUNT error so the caller omits the block (FR-006/FR-007)', async () => {
    const failing = {
      from: vi.fn(() => {
        const chain: Record<string, unknown> = {};
        const ret = () => chain;
        chain.select = () => ret();
        chain.eq = () => ret();
        chain.or = () => ret();
        chain.in = () => ret();
        chain.order = () => ret();
        chain.limit = () => Promise.resolve({ data: null, error: { message: 'boom' } });
        chain.then = (resolve: (v: unknown) => void) =>
          resolve({ count: null, data: null, error: { message: 'boom' } });
        return chain;
      }),
    } as unknown as SupabaseClient;
    const block = await countProposedPending(failing, { orgId: 'o', projectId: 'p' });
    expect(block).toBeNull();
  });

  it('builds a triage_url from a passed origin, null when origin absent (FR-005)', async () => {
    const client = makeMockClient({
      total: 0,
      byType: { decision: 0, pattern: 0, lesson: 0, constraint: 0 },
      previewRows: [],
    });
    const withOrigin = await countProposedPending(
      client,
      { orgId: 'o', projectId: 'proj-9' },
      { origin: 'https://valis.krukit.co' },
    );
    expect(withOrigin!.triage_url).toBe('https://valis.krukit.co/projects/proj-9/decisions/triage');

    const noOrigin = await countProposedPending(client, { orgId: 'o', projectId: 'proj-9' });
    expect(noOrigin!.triage_url).toBeNull();
  });
});
