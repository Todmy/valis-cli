import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Decision } from '../../src/types.js';

// Mock the batch Qdrant similarity helper so Tier-2 is deterministic. The
// production code calls `getSimilaritiesForNewDecision` once per detection
// (single round-trip, no N+1). Tests seed the returned map per case.
const getSimilaritiesMock =
  vi.fn<(...args: unknown[]) => Promise<Map<string, number>>>();
vi.mock('../../src/cloud/qdrant.js', () => ({
  getSimilaritiesForNewDecision: (...args: unknown[]) => getSimilaritiesMock(...args),
}));

import { detectContradictions } from '../../src/contradiction/detect.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const ORG_ID = '00000000-0000-0000-0000-000000000001';
const PROJECT_ID = '00000000-0000-0000-0000-0000000000aa';

function makeDecision(overrides: Partial<Decision> = {}): Decision {
  return {
    id: '00000000-0000-0000-0000-0000000000ff',
    org_id: ORG_ID,
    type: 'decision',
    summary: 'New decision',
    detail: 'New decision detail',
    status: 'proposed',
    author: 'tester',
    source: 'manual',
    project_id: PROJECT_ID,
    session_id: null,
    content_hash: 'hash',
    confidence: null,
    affects: ['postgres'],
    created_at: '2026-05-29T00:00:00Z',
    updated_at: '2026-05-29T00:00:00Z',
    ...overrides,
  };
}

interface MockSupabaseOptions {
  /** Rows the `decisions` candidate query should return. */
  decisionRows?: Decision[];
  /**
   * When set, the `decisions` query honours its `.in('status', [...])` filter
   * by returning only rows whose status is in the requested list. This lets a
   * test seed deprecated/superseded rows and assert the REAL query excludes
   * them (rather than asserting on a no-op recorder).
   */
  enforceStatusFilter?: boolean;
}

/**
 * Build a chainable Supabase mock that records the candidate query filters and
 * honours the status filter when asked.
 *
 * - `supabase.from('decisions')...` returns the seeded candidate rows, applying
 *   the `.in('status', …)` filter when `enforceStatusFilter` is set, and
 *   recording the chain so tests can assert on it.
 * - `supabase.from('contradictions')...` returns empty (no existing pair) for
 *   the dedup check and accepts inserts, recording inserted rows.
 */
function makeSupabase(opts: MockSupabaseOptions = {}) {
  const decisionRows = opts.decisionRows ?? [];

  const calls: {
    inStatus: string[] | null;
    eqStatus: string | null;
    selectCols: string | null;
    limit: number | null;
    table: string | null;
    rpcCalled: boolean;
  } = {
    inStatus: null,
    eqStatus: null,
    selectCols: null,
    limit: null,
    table: null,
    rpcCalled: false,
  };

  const insertedContradictions: Record<string, unknown>[] = [];

  // The RPC must NOT be called any more (#71 fix 7). If it is, record it so a
  // test can assert the guaranteed-failing round-trip is gone.
  const rpc = vi.fn(async () => {
    calls.rpcCalled = true;
    return { data: null, error: { message: 'function not found' } };
  });

  function decisionsBuilder() {
    let statusFilter: string[] | null = null;
    const builder: Record<string, unknown> = {};
    const chain = () => builder;
    builder.select = vi.fn((cols: string) => {
      calls.selectCols = cols;
      return builder;
    });
    builder.eq = vi.fn((col: string, val: string) => {
      if (col === 'status') calls.eqStatus = val;
      return builder;
    });
    builder.in = vi.fn((col: string, vals: string[]) => {
      if (col === 'status') {
        calls.inStatus = vals;
        statusFilter = vals;
      }
      return builder;
    });
    builder.neq = vi.fn(chain);
    builder.overlaps = vi.fn(chain);
    builder.limit = vi.fn((n: number) => {
      calls.limit = n;
      return builder;
    });
    builder.then = (resolve: (v: { data: Decision[]; error: null }) => unknown) => {
      const rows =
        opts.enforceStatusFilter && statusFilter
          ? decisionRows.filter((r) => statusFilter!.includes(r.status))
          : decisionRows;
      return resolve({ data: rows, error: null });
    };
    return builder;
  }

  function contradictionsBuilder() {
    const builder: Record<string, unknown> = {};
    const chain = () => builder;
    builder.select = vi.fn(chain);
    builder.eq = vi.fn(chain);
    builder.maybeSingle = vi.fn(async () => ({ data: null, error: null }));
    builder.insert = vi.fn(async (row: Record<string, unknown>) => {
      insertedContradictions.push(row);
      return { data: null, error: null };
    });
    return builder;
  }

  const from = vi.fn((table: string) => {
    calls.table = table;
    if (table === 'decisions') return decisionsBuilder();
    return contradictionsBuilder();
  });

  const supabase = { rpc, from } as unknown as SupabaseClient;
  return { supabase, calls, insertedContradictions };
}

// A non-null Qdrant client stand-in. Detection only uses it as a truthy gate;
// all vector math is mocked via getSimilaritiesForNewDecision.
const QDRANT = {} as unknown as Parameters<typeof detectContradictions>[1];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('detectContradictions — status gate', () => {
  beforeEach(() => {
    getSimilaritiesMock.mockReset();
    // Default: no Qdrant similarity available (empty map) → Tier-1 path.
    getSimilaritiesMock.mockResolvedValue(new Map());
  });

  // US1: proposed new decision vs existing active candidate. Two shared areas
  // clear the Tier-1 bar with Qdrant unavailable.
  it('flags a proposed new decision against an existing active candidate (Tier 1, qdrant=null)', async () => {
    const existing = makeDecision({
      id: '00000000-0000-0000-0000-0000000000a1',
      status: 'active',
      summary: 'Existing active decision',
      affects: ['postgres', 'auth'],
    });
    const { supabase } = makeSupabase({ decisionRows: [existing] });

    const newDecision = makeDecision({ status: 'proposed', affects: ['postgres', 'auth'] });
    const warnings = await detectContradictions(supabase, null, ORG_ID, newDecision);

    expect(warnings).toHaveLength(1);
    expect(warnings[0].decision_id).toBe(existing.id);
    expect(warnings[0].overlap_areas).toEqual(['postgres', 'auth']);
  });

  // US2: proposed-vs-proposed; assert candidate query widens to active+proposed.
  it('flags proposed-vs-proposed and queries status IN (active, proposed)', async () => {
    const existing = makeDecision({
      id: '00000000-0000-0000-0000-0000000000a2',
      status: 'proposed',
      summary: 'Existing proposed draft',
      affects: ['auth', 'jwt'],
    });
    const { supabase, calls } = makeSupabase({ decisionRows: [existing] });

    const newDecision = makeDecision({ status: 'proposed', affects: ['auth', 'jwt'] });
    const warnings = await detectContradictions(supabase, null, ORG_ID, newDecision);

    expect(calls.inStatus).toEqual(['active', 'proposed']);
    // The old active-only `.eq('status', 'active')` gate must be gone.
    expect(calls.eqStatus).toBeNull();
    expect(warnings).toHaveLength(1);
    expect(warnings[0].decision_id).toBe(existing.id);
  });

  // US2 negative (fix 5, red→green): seed REAL deprecated + superseded rows and
  // assert the REAL `.in('status', ['active','proposed'])` filter excludes them.
  it('does not surface deprecated or superseded candidates (real query exclusion)', async () => {
    const deprecated = makeDecision({
      id: '00000000-0000-0000-0000-0000000000d1',
      status: 'deprecated',
      summary: 'Deprecated decision',
      affects: ['auth', 'jwt'],
    });
    const superseded = makeDecision({
      id: '00000000-0000-0000-0000-0000000000d2',
      status: 'superseded',
      summary: 'Superseded decision',
      affects: ['auth', 'jwt'],
    });
    const active = makeDecision({
      id: '00000000-0000-0000-0000-0000000000d3',
      status: 'active',
      summary: 'Active decision',
      affects: ['auth', 'jwt'],
    });

    const { supabase, calls } = makeSupabase({
      decisionRows: [deprecated, superseded, active],
      enforceStatusFilter: true,
    });

    const newDecision = makeDecision({ status: 'proposed', affects: ['auth', 'jwt'] });
    const warnings = await detectContradictions(supabase, null, ORG_ID, newDecision);

    expect(calls.inStatus).toEqual(['active', 'proposed']);
    // Only the active row survives the real status filter.
    expect(warnings).toHaveLength(1);
    expect(warnings[0].decision_id).toBe(active.id);
    const flagged = warnings.map((w) => w.decision_id);
    expect(flagged).not.toContain(deprecated.id);
    expect(flagged).not.toContain(superseded.id);
  });

  // US3 regression: active-vs-active still works.
  it('still flags an active new decision against an active candidate (regression guard)', async () => {
    const existing = makeDecision({
      id: '00000000-0000-0000-0000-0000000000a3',
      status: 'active',
      summary: 'Existing active decision',
      affects: ['postgres', 'auth'],
    });
    const { supabase } = makeSupabase({ decisionRows: [existing] });

    const newDecision = makeDecision({ status: 'active', affects: ['postgres', 'auth'] });
    const warnings = await detectContradictions(supabase, null, ORG_ID, newDecision);

    expect(warnings).toHaveLength(1);
    expect(warnings[0].decision_id).toBe(existing.id);
  });

  // Edge case: empty affects returns immediately with no warnings.
  it('returns no warnings when the new decision has no affects', async () => {
    const { supabase, calls } = makeSupabase({ decisionRows: [] });
    const newDecision = makeDecision({ status: 'proposed', affects: [] });
    const warnings = await detectContradictions(supabase, null, ORG_ID, newDecision);

    expect(warnings).toHaveLength(0);
    // Early guard fires before any DB query.
    expect(calls.table).toBeNull();
  });

  // Fix 7: the guaranteed-failing find_contradiction_candidates RPC is gone.
  it('does not call the non-existent find_contradiction_candidates RPC', async () => {
    const existing = makeDecision({
      id: '00000000-0000-0000-0000-0000000000a5',
      status: 'active',
      affects: ['postgres', 'auth'],
    });
    const { supabase, calls } = makeSupabase({ decisionRows: [existing] });
    const newDecision = makeDecision({ status: 'proposed', affects: ['postgres', 'auth'] });
    await detectContradictions(supabase, null, ORG_ID, newDecision);

    expect(calls.rpcCalled).toBe(false);
  });

  // Fix 4: candidate query selects only needed columns and applies a limit.
  it('selects scoped columns and applies a candidate fetch limit', async () => {
    const { supabase, calls } = makeSupabase({ decisionRows: [] });
    const newDecision = makeDecision({ status: 'proposed', affects: ['postgres'] });
    await detectContradictions(supabase, null, ORG_ID, newDecision);

    expect(calls.selectCols).toBe('id,affects,summary,author,detail');
    expect(calls.selectCols).not.toBe('*');
    expect(typeof calls.limit).toBe('number');
    expect(calls.limit).toBeGreaterThan(0);
  });
});

describe('detectContradictions — Tier-2 similarity threshold (0.75 boundary)', () => {
  beforeEach(() => {
    getSimilaritiesMock.mockReset();
  });

  const existing = makeDecision({
    id: '00000000-0000-0000-0000-0000000000b1',
    status: 'active',
    summary: 'Existing active decision',
    affects: ['postgres'],
  });

  function seedSimilarity(value: number) {
    getSimilaritiesMock.mockResolvedValue(new Map([[existing.id, value]]));
  }

  it('suppresses a 0.72 similarity pair', async () => {
    seedSimilarity(0.72);
    const { supabase } = makeSupabase({ decisionRows: [existing] });
    const newDecision = makeDecision({ status: 'proposed', affects: ['postgres'] });
    const warnings = await detectContradictions(supabase, QDRANT, ORG_ID, newDecision);
    expect(warnings).toHaveLength(0);
  });

  // Pin the boundary: code uses strict `>`. Exactly 0.75 must NOT flag.
  it('suppresses an exactly-0.75 pair (strict > boundary)', async () => {
    seedSimilarity(0.75);
    const { supabase } = makeSupabase({ decisionRows: [existing] });
    const newDecision = makeDecision({ status: 'proposed', affects: ['postgres'] });
    const warnings = await detectContradictions(supabase, QDRANT, ORG_ID, newDecision);
    expect(warnings).toHaveLength(0);
  });

  it('flags a 0.7500001 pair just above the boundary', async () => {
    seedSimilarity(0.7500001);
    const { supabase } = makeSupabase({ decisionRows: [existing] });
    const newDecision = makeDecision({ status: 'proposed', affects: ['postgres'] });
    const warnings = await detectContradictions(supabase, QDRANT, ORG_ID, newDecision);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].similarity).toBe(0.7500001);
  });

  it('flags a 0.76 pair and records the real similarity', async () => {
    seedSimilarity(0.76);
    const { supabase } = makeSupabase({ decisionRows: [existing] });
    const newDecision = makeDecision({ status: 'proposed', affects: ['postgres'] });
    const warnings = await detectContradictions(supabase, QDRANT, ORG_ID, newDecision);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].similarity).toBe(0.76);
  });
});

describe('detectContradictions — Tier-1 false-positive guard (#71)', () => {
  beforeEach(() => {
    getSimilaritiesMock.mockReset();
    getSimilaritiesMock.mockResolvedValue(new Map()); // Qdrant unavailable
  });

  // Fix 2: a single shared tag out of many must NOT flag when Qdrant is down.
  it('does NOT flag a single shared affects tag out of many (Qdrant unavailable)', async () => {
    const existing = makeDecision({
      id: '00000000-0000-0000-0000-0000000000c1',
      status: 'proposed',
      summary: 'Broad existing decision',
      affects: ['postgres', 'auth', 'billing', 'search'],
    });
    const { supabase } = makeSupabase({ decisionRows: [existing] });

    const newDecision = makeDecision({
      status: 'proposed',
      affects: ['postgres', 'caching', 'ui', 'cli'], // only `postgres` shared (1/7 union)
    });
    const warnings = await detectContradictions(supabase, null, ORG_ID, newDecision);

    expect(warnings).toHaveLength(0);
  });

  // The single-shared-tag case still flags when that tag dominates (Jaccard).
  it('flags a single shared tag when it dominates the tag set (Jaccard ≥ 0.5)', async () => {
    const existing = makeDecision({
      id: '00000000-0000-0000-0000-0000000000c2',
      status: 'proposed',
      summary: 'Narrow existing decision',
      affects: ['postgres'],
    });
    const { supabase } = makeSupabase({ decisionRows: [existing] });

    const newDecision = makeDecision({ status: 'proposed', affects: ['postgres'] });
    const warnings = await detectContradictions(supabase, null, ORG_ID, newDecision);

    expect(warnings).toHaveLength(1);
    expect(warnings[0].decision_id).toBe(existing.id);
  });

  // Bulk-index simulation: N proposed decisions all tagged the SAME single
  // broad tag among others must not explode into O(N²) flags. We model one
  // new decision against many candidates each sharing only `postgres`.
  it('does not explode on bulk index where every pair shares one broad tag', async () => {
    const candidates: Decision[] = Array.from({ length: 40 }, (_, i) =>
      makeDecision({
        id: `00000000-0000-0000-0000-0000000${String(i).padStart(5, '0')}`,
        status: 'proposed',
        summary: `Bulk decision ${i}`,
        // Each candidate shares ONLY `postgres` with the new decision, plus its
        // own distinct tags — exactly the bulk-index pathology.
        affects: ['postgres', `feature-${i}`, `area-${i}`],
      }),
    );
    const { supabase, insertedContradictions } = makeSupabase({ decisionRows: candidates });

    const newDecision = makeDecision({
      status: 'proposed',
      affects: ['postgres', 'orchestrator', 'pipeline'],
    });
    const warnings = await detectContradictions(supabase, null, ORG_ID, newDecision);

    // No single-tag pair clears the bar → no explosion, no inserts.
    expect(warnings).toHaveLength(0);
    expect(insertedContradictions).toHaveLength(0);
  });

  // Fix 3: Tier-1 warnings/inserts carry null similarity, mirroring the DB.
  it('records null similarity on the Tier-1 path (warning + DB row agree)', async () => {
    const existing = makeDecision({
      id: '00000000-0000-0000-0000-0000000000c3',
      status: 'active',
      affects: ['postgres', 'auth'],
    });
    const { supabase, insertedContradictions } = makeSupabase({ decisionRows: [existing] });

    const newDecision = makeDecision({ status: 'proposed', affects: ['postgres', 'auth'] });
    const warnings = await detectContradictions(supabase, null, ORG_ID, newDecision);

    expect(warnings).toHaveLength(1);
    expect(warnings[0].similarity).toBeNull();
    expect(insertedContradictions).toHaveLength(1);
    expect(insertedContradictions[0].similarity_score).toBeNull();
  });
});
