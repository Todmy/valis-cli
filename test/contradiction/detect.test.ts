/**
 * 044/T007+T010: opposition-gate detection.
 *
 * The gate replaced the similarity-only trigger: tag overlap and cosine are
 * nominators only; an opposition verdict decides. Tests use a faked classifier
 * (no live LLM) and a chainable Supabase mock.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Decision } from '../../src/types.js';
import type { OppositionClassifier, OppositionVerdict } from '../../src/contradiction/classify.js';

const getSimilaritiesMock =
  vi.fn<(...args: unknown[]) => Promise<Map<string, number>>>();
vi.mock('../../src/cloud/qdrant.js', () => ({
  getSimilaritiesForNewDecision: (...args: unknown[]) => getSimilaritiesMock(...args),
}));

import { detectContradictions } from '../../src/contradiction/detect.js';

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

// --- fake classifiers ---
const COMPATIBLE: OppositionVerdict = { classification: 'compatible', confidence: 0.9, abstained: false };
const CONFLICT: OppositionVerdict = { classification: 'genuine_conflict', confidence: 0.9, abstained: false };
const REPLACEMENT: OppositionVerdict = { classification: 'replacement', confidence: 0.85, abstained: false };
const UNCERTAIN: OppositionVerdict = { classification: 'uncertain', confidence: 0, abstained: true, reason: 'classifier_error' };

function constClassifier(v: OppositionVerdict): OppositionClassifier {
  return async () => v;
}
/** Classifier that returns a per-candidate verdict (keyed by candidate id = B). */
function perCandidateClassifier(map: Record<string, OppositionVerdict>, fallback = COMPATIBLE): OppositionClassifier {
  return async (_a, b) => map[b.id] ?? fallback;
}

interface MockSupabaseOptions {
  decisionRows?: Decision[];
  /** Seed an already-existing contradiction row for the dedup/suppressed check. */
  existingContradiction?: { id: string; suppressed: boolean | null } | null;
}

function makeSupabase(opts: MockSupabaseOptions = {}) {
  const decisionRows = opts.decisionRows ?? [];
  const calls: { table: string | null; decisionUpdateCalled: boolean } = {
    table: null,
    decisionUpdateCalled: false,
  };
  const insertedContradictions: Record<string, unknown>[] = [];

  function decisionsBuilder() {
    const builder: Record<string, unknown> = {};
    const chain = () => builder;
    builder.select = vi.fn(chain);
    builder.eq = vi.fn(chain);
    builder.in = vi.fn(chain);
    builder.neq = vi.fn(chain);
    builder.overlaps = vi.fn(chain);
    builder.limit = vi.fn(chain);
    // Any update/delete to `decisions` would be an escalate-first violation.
    builder.update = vi.fn(() => {
      calls.decisionUpdateCalled = true;
      return builder;
    });
    builder.then = (resolve: (v: { data: Decision[]; error: null }) => unknown) =>
      resolve({ data: decisionRows, error: null });
    return builder;
  }

  function contradictionsBuilder() {
    const builder: Record<string, unknown> = {};
    const chain = () => builder;
    builder.select = vi.fn(chain);
    builder.eq = vi.fn(chain);
    builder.maybeSingle = vi.fn(async () => ({
      data: opts.existingContradiction ?? null,
      error: null,
    }));
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

  const supabase = { from } as unknown as SupabaseClient;
  return { supabase, calls, insertedContradictions };
}

const QDRANT = {} as unknown as Parameters<typeof detectContradictions>[1];

beforeEach(() => {
  getSimilaritiesMock.mockReset();
  getSimilaritiesMock.mockResolvedValue(new Map());
});

// ---------------------------------------------------------------------------
// US1 — aligned pairs no longer flagged (T007)
// ---------------------------------------------------------------------------

describe('opposition-gate — US1: compatible suppression (FR-001/002/007/010)', () => {
  const existing = makeDecision({
    id: '00000000-0000-0000-0000-0000000000a1',
    status: 'active',
    summary: 'Existing aligned decision',
    affects: ['postgres', 'auth'],
  });

  it('FR-001: full affects overlap + compatible verdict ⇒ no contradiction', async () => {
    const { supabase, insertedContradictions } = makeSupabase({ decisionRows: [existing] });
    const newDecision = makeDecision({ affects: ['postgres', 'auth'] });
    const warnings = await detectContradictions(supabase, null, ORG_ID, newDecision, constClassifier(COMPATIBLE));
    expect(warnings).toHaveLength(0);
    expect(insertedContradictions).toHaveLength(0);
  });

  it('FR-002: high cosine + compatible verdict ⇒ no contradiction (similarity is not a flagging authority)', async () => {
    getSimilaritiesMock.mockResolvedValue(new Map([[existing.id, 0.95]]));
    const { supabase, insertedContradictions } = makeSupabase({ decisionRows: [existing] });
    const newDecision = makeDecision({ affects: ['postgres', 'auth'] });
    const warnings = await detectContradictions(supabase, QDRANT, ORG_ID, newDecision, constClassifier(COMPATIBLE));
    expect(warnings).toHaveLength(0);
    expect(insertedContradictions).toHaveLength(0);
  });

  it('FR-007: a compatible suppression mutates no decision status/lineage', async () => {
    const { supabase, calls } = makeSupabase({ decisionRows: [existing] });
    const newDecision = makeDecision({ affects: ['postgres', 'auth'] });
    await detectContradictions(supabase, null, ORG_ID, newDecision, constClassifier(COMPATIBLE));
    expect(calls.decisionUpdateCalled).toBe(false);
  });

  it('FR-010: an already-suppressed pair is not re-surfaced even on a conflict verdict', async () => {
    const { supabase, insertedContradictions } = makeSupabase({
      decisionRows: [existing],
      existingContradiction: { id: 'c1', suppressed: true },
    });
    const newDecision = makeDecision({ affects: ['postgres', 'auth'] });
    const warnings = await detectContradictions(supabase, null, ORG_ID, newDecision, constClassifier(CONFLICT));
    expect(warnings).toHaveLength(0);
    expect(insertedContradictions).toHaveLength(0);
  });

  it('Constitution III/IV: a throwing classifier resolves (store not blocked)', async () => {
    const throwing: OppositionClassifier = async () => {
      throw new Error('classifier exploded');
    };
    const { supabase } = makeSupabase({ decisionRows: [existing] });
    const newDecision = makeDecision({ affects: ['postgres', 'auth'] });
    await expect(
      detectContradictions(supabase, null, ORG_ID, newDecision, throwing),
    ).resolves.toBeDefined();
  });

  it('Constitution IV: no classifier ⇒ gate OFF (no query, no rows)', async () => {
    const { supabase, calls } = makeSupabase({ decisionRows: [existing] });
    const newDecision = makeDecision({ affects: ['postgres', 'auth'] });
    const warnings = await detectContradictions(supabase, null, ORG_ID, newDecision);
    expect(warnings).toHaveLength(0);
    expect(calls.table).toBeNull(); // early return before any DB query
  });

  it('empty affects ⇒ no warnings, no query', async () => {
    const { supabase, calls } = makeSupabase({ decisionRows: [existing] });
    const newDecision = makeDecision({ affects: [] });
    const warnings = await detectContradictions(supabase, null, ORG_ID, newDecision, constClassifier(CONFLICT));
    expect(warnings).toHaveLength(0);
    expect(calls.table).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// US2 — genuine conflicts + replacement branch (T010)
// ---------------------------------------------------------------------------

describe('opposition-gate — US2: conflict / replacement / uncertain branches', () => {
  const existing = makeDecision({
    id: '00000000-0000-0000-0000-0000000000b1',
    status: 'active',
    summary: 'Existing decision',
    affects: ['postgres'],
  });

  it('genuine_conflict ⇒ row inserted with cached verdict', async () => {
    const { supabase, insertedContradictions } = makeSupabase({ decisionRows: [existing] });
    const newDecision = makeDecision({ affects: ['postgres'] });
    const warnings = await detectContradictions(supabase, null, ORG_ID, newDecision, constClassifier(CONFLICT));
    expect(warnings).toHaveLength(1);
    expect(warnings[0].verdict_classification).toBe('genuine_conflict');
    expect(warnings[0].verdict_confidence).toBe(0.9);
    expect(warnings[0].propose_supersede).toBeUndefined();
    expect(insertedContradictions).toHaveLength(1);
    expect(insertedContradictions[0].verdict_classification).toBe('genuine_conflict');
    expect(insertedContradictions[0].verdict_confidence).toBe(0.9);
    expect(insertedContradictions[0].verdict_assessed_at).toBeTruthy();
  });

  it('replacement ⇒ row + propose_supersede, NO decision status mutation (FR-004 escalate-first)', async () => {
    const { supabase, calls, insertedContradictions } = makeSupabase({ decisionRows: [existing] });
    const newDecision = makeDecision({ affects: ['postgres'] });
    const warnings = await detectContradictions(supabase, null, ORG_ID, newDecision, constClassifier(REPLACEMENT));
    expect(warnings).toHaveLength(1);
    expect(warnings[0].verdict_classification).toBe('replacement');
    expect(warnings[0].propose_supersede).toEqual({
      superseded_id: existing.id, // the older existing decision
      supersedes_id: newDecision.id, // the newer one wins (recency)
    });
    expect(calls.decisionUpdateCalled).toBe(false); // propose-only — no auto state change
    expect(insertedContradictions).toHaveLength(1);
  });

  it('uncertain (abstain) ⇒ row surfaced low-confidence (null confidence)', async () => {
    const { supabase, insertedContradictions } = makeSupabase({ decisionRows: [existing] });
    const newDecision = makeDecision({ affects: ['postgres'] });
    const warnings = await detectContradictions(supabase, null, ORG_ID, newDecision, constClassifier(UNCERTAIN));
    expect(warnings).toHaveLength(1);
    expect(warnings[0].verdict_classification).toBe('uncertain');
    expect(warnings[0].verdict_confidence).toBeNull();
    expect(insertedContradictions[0].verdict_classification).toBe('uncertain');
  });

  it('FR-009: a low-confidence genuine_conflict still surfaces', async () => {
    const lowConf: OppositionVerdict = { classification: 'genuine_conflict', confidence: 0.2, abstained: false };
    const { supabase } = makeSupabase({ decisionRows: [existing] });
    const newDecision = makeDecision({ affects: ['postgres'] });
    const warnings = await detectContradictions(supabase, null, ORG_ID, newDecision, constClassifier(lowConf));
    expect(warnings).toHaveLength(1);
    expect(warnings[0].verdict_confidence).toBe(0.2);
  });

  it('no_classifier abstain (defensive) ⇒ not surfaced (degrade off, no flood)', async () => {
    const keyless: OppositionVerdict = { classification: 'uncertain', confidence: 0, abstained: true, reason: 'no_classifier' };
    const { supabase, insertedContradictions } = makeSupabase({ decisionRows: [existing] });
    const newDecision = makeDecision({ affects: ['postgres'] });
    const warnings = await detectContradictions(supabase, null, ORG_ID, newDecision, constClassifier(keyless));
    expect(warnings).toHaveLength(0);
    expect(insertedContradictions).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Cap + temporal-cue (T013 / FR-011)
// ---------------------------------------------------------------------------

describe('opposition-gate — top-K cap + temporal-cue (FR-011)', () => {
  function manyCandidates(n: number): Decision[] {
    return Array.from({ length: n }, (_, i) =>
      makeDecision({
        id: `00000000-0000-0000-0000-0000000${String(i).padStart(5, '0')}`,
        status: 'active',
        summary: `Candidate ${i}`,
        affects: ['postgres'],
      }),
    );
  }

  it('classifies at most top-K=5 by cosine when no cue present', async () => {
    const cands = manyCandidates(8);
    // Descending similarity 0.9..0.2; the 6th–8th fall outside top-5.
    getSimilaritiesMock.mockResolvedValue(
      new Map(cands.map((c, i) => [c.id, 0.9 - i * 0.1])),
    );
    const seen: string[] = [];
    const classifier: OppositionClassifier = async (_a, b) => {
      seen.push(b.id);
      return COMPATIBLE;
    };
    const { supabase } = makeSupabase({ decisionRows: cands });
    const newDecision = makeDecision({ summary: 'plain', detail: 'plain body', affects: ['postgres'] });
    await detectContradictions(supabase, QDRANT, ORG_ID, newDecision, classifier);
    expect(seen).toHaveLength(5); // capped
  });

  it('temporal cue in the NEW decision force-includes a low-cosine candidate', async () => {
    const cands = manyCandidates(8);
    getSimilaritiesMock.mockResolvedValue(
      new Map(cands.map((c, i) => [c.id, 0.9 - i * 0.1])),
    );
    const target = cands[7]; // lowest cosine, normally outside top-5
    const classifier = perCandidateClassifier({ [target.id]: CONFLICT });
    const { supabase } = makeSupabase({ decisionRows: cands });
    const newDecision = makeDecision({
      summary: 'We are dropping Firecrawl, moving to Apify',
      detail: 'switched from Firecrawl',
      affects: ['postgres'],
    });
    const warnings = await detectContradictions(supabase, QDRANT, ORG_ID, newDecision, classifier);
    const flagged = warnings.map((w) => w.decision_id);
    expect(flagged).toContain(target.id); // the cue forced classification despite low cosine
  });
});
