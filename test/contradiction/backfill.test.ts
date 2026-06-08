/**
 * 044/T016: backfill sweep over existing open contradictions (FR-014).
 */
import { describe, it, expect, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { OppositionClassifier, OppositionVerdict } from '../../src/contradiction/classify.js';
import { backfillOppositionVerdicts } from '../../src/contradiction/backfill.js';

const COMPATIBLE: OppositionVerdict = { classification: 'compatible', confidence: 0.9, abstained: false };
const CONFLICT: OppositionVerdict = { classification: 'genuine_conflict', confidence: 0.8, abstained: false };
const UNCERTAIN: OppositionVerdict = { classification: 'uncertain', confidence: 0, abstained: true, reason: 'classifier_error' };

function constClassifier(v: OppositionVerdict): OppositionClassifier {
  return async () => v;
}
function perPairClassifier(byB: Record<string, OppositionVerdict>): OppositionClassifier {
  return async (_a, b) => byB[b.id] ?? COMPATIBLE;
}

interface Pair {
  id: string;
  decision_a_id: string;
  decision_b_id: string;
}

function makeSupabase(opts: {
  pairs: Pair[];
  decisions?: Array<{ id: string; summary: string | null; detail: string }>;
}) {
  const updates: Array<{ id: string; payload: Record<string, unknown> }> = [];
  const decisions =
    opts.decisions ??
    opts.pairs.flatMap((p) => [
      { id: p.decision_a_id, summary: 'A', detail: 'a body' },
      { id: p.decision_b_id, summary: 'B', detail: 'b body' },
    ]);

  function contradictionsBuilder() {
    const builder: Record<string, unknown> = {};
    let pendingUpdate: Record<string, unknown> | null = null;
    const chain = () => builder;
    builder.select = vi.fn(chain);
    builder.update = vi.fn((payload: Record<string, unknown>) => {
      pendingUpdate = payload;
      return builder;
    });
    builder.eq = vi.fn((col: string, val: unknown) => {
      if (col === 'id' && pendingUpdate) {
        updates.push({ id: String(val), payload: pendingUpdate });
        pendingUpdate = null;
      }
      return builder;
    });
    // Awaiting the select chain resolves the open pairs.
    builder.then = (resolve: (v: { data: Pair[]; error: null }) => unknown) =>
      resolve({ data: opts.pairs, error: null });
    return builder;
  }

  function decisionsBuilder() {
    const builder: Record<string, unknown> = {};
    builder.select = vi.fn(() => builder);
    builder.in = vi.fn((_col: string, ids: string[]) => {
      const rows = decisions.filter((d) => ids.includes(d.id));
      return Promise.resolve({ data: rows, error: null });
    });
    return builder;
  }

  const from = vi.fn((table: string) =>
    table === 'decisions' ? decisionsBuilder() : contradictionsBuilder(),
  );
  const supabase = { from } as unknown as SupabaseClient;
  return { supabase, updates };
}

const PAIRS: Pair[] = [
  { id: 'c1', decision_a_id: 'a1', decision_b_id: 'b1' },
  { id: 'c2', decision_a_id: 'a2', decision_b_id: 'b2' },
];

describe('backfillOppositionVerdicts', () => {
  it('dryRun returns counts without any writes', async () => {
    const { supabase, updates } = makeSupabase({ pairs: PAIRS });
    const res = await backfillOppositionVerdicts(supabase, constClassifier(COMPATIBLE), { dryRun: true });
    expect(res.scanned).toBe(2);
    expect(res.suppressed).toBe(2);
    expect(updates).toHaveLength(0);
  });

  it('compatible ⇒ suppressed=true (reversible flag), verdict cached', async () => {
    const { supabase, updates } = makeSupabase({ pairs: PAIRS });
    const res = await backfillOppositionVerdicts(supabase, constClassifier(COMPATIBLE));
    expect(res.suppressed).toBe(2);
    expect(updates).toHaveLength(2);
    expect(updates[0].payload.suppressed).toBe(true);
    expect(updates[0].payload.verdict_classification).toBe('compatible');
  });

  it('genuine_conflict ⇒ retained (not suppressed), verdict cached', async () => {
    const { supabase, updates } = makeSupabase({ pairs: PAIRS });
    const res = await backfillOppositionVerdicts(supabase, constClassifier(CONFLICT));
    expect(res.retained).toBe(2);
    expect(res.suppressed).toBe(0);
    expect(updates[0].payload.suppressed).toBeUndefined();
    expect(updates[0].payload.verdict_classification).toBe('genuine_conflict');
  });

  it('uncertain ⇒ abstained, left untouched (no update)', async () => {
    const { supabase, updates } = makeSupabase({ pairs: PAIRS });
    const res = await backfillOppositionVerdicts(supabase, constClassifier(UNCERTAIN));
    expect(res.abstained).toBe(2);
    expect(updates).toHaveLength(0);
  });

  it('mixed verdicts tally correctly', async () => {
    const { supabase } = makeSupabase({ pairs: PAIRS });
    const res = await backfillOppositionVerdicts(
      supabase,
      perPairClassifier({ b1: COMPATIBLE, b2: CONFLICT }),
    );
    expect(res).toEqual({ scanned: 2, suppressed: 1, retained: 1, abstained: 0 });
  });

  it('a missing decision ⇒ abstained, untouched', async () => {
    const { supabase, updates } = makeSupabase({
      pairs: [{ id: 'c9', decision_a_id: 'x', decision_b_id: 'y' }],
      decisions: [{ id: 'x', summary: 'only one side', detail: 'x' }], // y missing
    });
    const res = await backfillOppositionVerdicts(supabase, constClassifier(COMPATIBLE));
    expect(res.abstained).toBe(1);
    expect(res.suppressed).toBe(0);
    expect(updates).toHaveLength(0);
  });
});
