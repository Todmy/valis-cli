import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PatternCandidate } from '../../src/types.js';

// ---------------------------------------------------------------------------
// Unit tests for synthesis module (T066)
//
// Tests:
//   - Jaccard similarity computation
//   - Cluster identification via clusterByJaccard
//   - Average pairwise Jaccard cohesion
//   - Pattern deduplication
//   - detectPatterns end-to-end (with mock Supabase)
//   - Idempotency (runner skips existing patterns)
//   - Stale pattern deprecation
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Mocks — factories must not reference outer scope variables
// ---------------------------------------------------------------------------

const mockStoreDecision = vi.fn().mockResolvedValue({
  id: 'new-pattern-id',
  org_id: 'test-org',
  type: 'pattern',
  detail: 'Team pattern: auth — 3 decisions in 30 days',
  status: 'active',
  author: 'system',
  source: 'synthesis',
  content_hash: 'hash123',
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  affects: ['auth'],
  depends_on: ['d1', 'd2', 'd3'],
  summary: 'Team pattern: auth — 3 decisions in 30 days',
});

const mockChangeDecisionStatus = vi.fn().mockResolvedValue({
  id: 'stale-pattern-id',
  status: 'deprecated',
});

const mockCreateAuditEntry = vi.fn().mockResolvedValue({ id: 'audit-1' });
const mockBuildAuditPayload = vi.fn().mockReturnValue({
  org_id: 'test-org',
  member_id: 'system',
  action: 'pattern_synthesized',
  target_type: 'decision',
  target_id: 'new-pattern-id',
  previous_state: null,
  new_state: {},
  reason: null,
});

vi.mock('../../src/cloud/supabase.js', () => ({
  getSupabaseClient: vi.fn().mockReturnValue({}),
  storeDecision: (...args: unknown[]) => mockStoreDecision(...args),
  changeDecisionStatus: (...args: unknown[]) => mockChangeDecisionStatus(...args),
}));

vi.mock('../../src/auth/audit.js', () => ({
  buildAuditPayload: (...args: unknown[]) => mockBuildAuditPayload(...args),
  createAuditEntry: (...args: unknown[]) => mockCreateAuditEntry(...args),
}));

vi.mock('../../src/config/store.js', () => ({
  loadConfig: vi.fn().mockResolvedValue({
    org_id: 'test-org',
    supabase_url: 'https://test.supabase.co',
    supabase_service_role_key: 'test-key',
  }),
}));

// Import AFTER mocks
import {
  jaccard,
  clusterByJaccard,
  averagePairwiseJaccard,
  deduplicatePatterns,
  detectPatterns,
} from '../../src/synthesis/patterns.js';
import { runSynthesis } from '../../src/synthesis/runner.js';

// ---------------------------------------------------------------------------
// Mock Supabase query chain helper
// ---------------------------------------------------------------------------

function mockQueryChain(data: unknown[] | null, error: unknown = null) {
  const chain: Record<string, unknown> = {};
  const terminal = { data, error, count: data?.length ?? 0 };

  const self = new Proxy(chain, {
    get(_target, prop) {
      if (prop === 'data') return data;
      if (prop === 'error') return error;
      if (prop === 'count') return terminal.count;
      if (typeof prop === 'string' && ['single', 'then'].includes(prop)) {
        return () => terminal;
      }
      return (..._args: unknown[]) => self;
    },
  });

  return self;
}

function createMockSupabase(fromImpl: () => unknown) {
  return { from: vi.fn().mockImplementation(fromImpl) };
}

// ---------------------------------------------------------------------------
// Jaccard similarity (T062)
// ---------------------------------------------------------------------------

describe('jaccard', () => {
  it('returns 1 for identical arrays', () => {
    expect(jaccard(['auth', 'api'], ['auth', 'api'])).toBe(1);
  });

  it('returns 0 for disjoint arrays', () => {
    expect(jaccard(['auth'], ['database'])).toBe(0);
  });

  it('returns 0 for two empty arrays', () => {
    expect(jaccard([], [])).toBe(0);
  });

  it('returns 0 when one array is empty', () => {
    expect(jaccard(['auth'], [])).toBe(0);
  });

  it('computes correct value for partial overlap', () => {
    // intersection = {auth}, union = {auth, api, database}
    expect(jaccard(['auth', 'api'], ['auth', 'database'])).toBeCloseTo(1 / 3);
  });

  it('handles duplicates in input arrays', () => {
    // Sets: {auth, api} and {auth, api} => 1.0
    expect(jaccard(['auth', 'auth', 'api'], ['auth', 'api'])).toBe(1);
  });

  it('computes 0.5 for half overlap', () => {
    // intersection = {a}, union = {a, b}
    expect(jaccard(['a'], ['a', 'b'])).toBeCloseTo(0.5);
  });
});

// ---------------------------------------------------------------------------
// Clustering (T061)
// ---------------------------------------------------------------------------

describe('clusterByJaccard', () => {
  it('groups similar decisions into one cluster', () => {
    const decisions = [
      { id: 'd1', affects: ['auth', 'api'], summary: null, type: 'decision', created_at: '' },
      { id: 'd2', affects: ['auth', 'api', 'database'], summary: null, type: 'decision', created_at: '' },
      { id: 'd3', affects: ['auth'], summary: null, type: 'decision', created_at: '' },
    ];
    // d1-d2: jaccard(['auth','api'], ['auth','api','database']) = 2/3 >= 0.3
    // d1-d3: jaccard(['auth','api'], ['auth']) = 1/2 >= 0.3
    const clusters = clusterByJaccard(decisions, 0.3);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]).toHaveLength(3);
  });

  it('separates unrelated decisions into distinct clusters', () => {
    const decisions = [
      { id: 'd1', affects: ['auth'], summary: null, type: 'decision', created_at: '' },
      { id: 'd2', affects: ['auth'], summary: null, type: 'decision', created_at: '' },
      { id: 'd3', affects: ['billing'], summary: null, type: 'decision', created_at: '' },
      { id: 'd4', affects: ['billing'], summary: null, type: 'decision', created_at: '' },
    ];
    // auth-billing jaccard = 0 < 0.3
    const clusters = clusterByJaccard(decisions, 0.3);
    expect(clusters).toHaveLength(2);
    expect(clusters[0].map((d) => d.id).sort()).toEqual(['d1', 'd2']);
    expect(clusters[1].map((d) => d.id).sort()).toEqual(['d3', 'd4']);
  });

  it('returns single-item clusters for isolated decisions', () => {
    const decisions = [
      { id: 'd1', affects: ['auth'], summary: null, type: 'decision', created_at: '' },
      { id: 'd2', affects: ['billing'], summary: null, type: 'decision', created_at: '' },
      { id: 'd3', affects: ['infra'], summary: null, type: 'decision', created_at: '' },
    ];
    const clusters = clusterByJaccard(decisions, 0.3);
    expect(clusters).toHaveLength(3);
  });

  it('handles empty input', () => {
    const clusters = clusterByJaccard([], 0.3);
    expect(clusters).toHaveLength(0);
  });

  it('uses single-linkage to grow clusters transitively', () => {
    // d1 links to d2 (jaccard 1/3), d2 links to d3 (jaccard 1/3),
    // but d1 does not directly link to d3 (jaccard 0).
    // Single-linkage should put them all in one cluster.
    const decisions = [
      { id: 'd1', affects: ['a', 'b'], summary: null, type: 'decision', created_at: '' },
      { id: 'd2', affects: ['b', 'c'], summary: null, type: 'decision', created_at: '' },
      { id: 'd3', affects: ['c', 'd'], summary: null, type: 'decision', created_at: '' },
    ];
    const clusters = clusterByJaccard(decisions, 0.3);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// Average pairwise Jaccard
// ---------------------------------------------------------------------------

describe('averagePairwiseJaccard', () => {
  it('returns 1 for a single decision', () => {
    const decisions = [{ id: 'd1', affects: ['auth'], summary: null, type: 'decision', created_at: '' }];
    expect(averagePairwiseJaccard(decisions)).toBe(1);
  });

  it('computes correctly for identical decisions', () => {
    const decisions = [
      { id: 'd1', affects: ['auth', 'api'], summary: null, type: 'decision', created_at: '' },
      { id: 'd2', affects: ['auth', 'api'], summary: null, type: 'decision', created_at: '' },
    ];
    expect(averagePairwiseJaccard(decisions)).toBe(1);
  });

  it('computes correctly for mixed similarity', () => {
    const decisions = [
      { id: 'd1', affects: ['auth'], summary: null, type: 'decision', created_at: '' },
      { id: 'd2', affects: ['auth', 'api'], summary: null, type: 'decision', created_at: '' },
      { id: 'd3', affects: ['auth', 'api', 'database'], summary: null, type: 'decision', created_at: '' },
    ];
    // d1-d2: 1/2 = 0.5
    // d1-d3: 1/3 ~= 0.333
    // d2-d3: 2/3 ~= 0.667
    // Average: (0.5 + 0.333 + 0.667) / 3 = 0.5
    expect(averagePairwiseJaccard(decisions)).toBeCloseTo(0.5, 1);
  });
});

// ---------------------------------------------------------------------------
// Pattern deduplication
// ---------------------------------------------------------------------------

describe('deduplicatePatterns', () => {
  it('keeps non-overlapping candidates', () => {
    const candidates: PatternCandidate[] = [
      { affects: ['auth'], decision_ids: ['d1', 'd2', 'd3'], cohesion: 0.8, already_exists: false },
      { affects: ['billing'], decision_ids: ['d4', 'd5', 'd6'], cohesion: 0.7, already_exists: false },
    ];
    const result = deduplicatePatterns(candidates);
    expect(result).toHaveLength(2);
  });

  it('removes candidate with 100% overlap (keeps higher cohesion)', () => {
    const candidates: PatternCandidate[] = [
      { affects: ['auth'], decision_ids: ['d1', 'd2', 'd3'], cohesion: 0.9, already_exists: false },
      { affects: ['auth'], decision_ids: ['d1', 'd2', 'd3'], cohesion: 0.7, already_exists: false },
    ];
    // Jaccard of IDs: 1.0 > 0.8 => deduplicate
    const result = deduplicatePatterns(candidates);
    expect(result).toHaveLength(1);
    expect(result[0].cohesion).toBe(0.9);
  });

  it('returns empty array for empty input', () => {
    expect(deduplicatePatterns([])).toHaveLength(0);
  });

  it('returns single candidate unchanged', () => {
    const candidates: PatternCandidate[] = [
      { affects: ['auth'], decision_ids: ['d1', 'd2', 'd3'], cohesion: 0.8, already_exists: false },
    ];
    expect(deduplicatePatterns(candidates)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// detectPatterns end-to-end (with mock Supabase)
// ---------------------------------------------------------------------------

describe('detectPatterns', () => {
  it('detects a cluster of 3+ decisions in the same area', async () => {
    const now = new Date().toISOString();
    const decisions = [
      { id: 'd1', affects: ['auth', 'api'], summary: 'Auth decision', type: 'decision', created_at: now },
      { id: 'd2', affects: ['auth', 'api'], summary: 'Auth pattern', type: 'decision', created_at: now },
      { id: 'd3', affects: ['auth'], summary: 'Auth constraint', type: 'constraint', created_at: now },
    ];

    const supabase = createMockSupabase(() => mockQueryChain(decisions));

    const result = await detectPatterns(supabase as any, 'test-org', {
      windowDays: 30,
      minCluster: 3,
    });

    expect(result.length).toBeGreaterThanOrEqual(1);
    expect(result[0].decision_ids).toHaveLength(3);
    expect(result[0].affects).toContain('auth');
  });

  it('returns empty when fewer than minCluster decisions exist', async () => {
    const now = new Date().toISOString();
    const decisions = [
      { id: 'd1', affects: ['auth'], summary: 'Only one', type: 'decision', created_at: now },
    ];

    const supabase = createMockSupabase(() => mockQueryChain(decisions));

    const result = await detectPatterns(supabase as any, 'test-org', {
      windowDays: 30,
      minCluster: 3,
    });

    expect(result).toHaveLength(0);
  });

  it('returns empty when no decisions match', async () => {
    const supabase = createMockSupabase(() => mockQueryChain([]));

    const result = await detectPatterns(supabase as any, 'test-org', {
      windowDays: 30,
      minCluster: 3,
    });

    expect(result).toHaveLength(0);
  });

  it('separates unrelated areas into distinct patterns', async () => {
    const now = new Date().toISOString();
    const decisions = [
      { id: 'd1', affects: ['auth'], summary: 'a1', type: 'decision', created_at: now },
      { id: 'd2', affects: ['auth'], summary: 'a2', type: 'decision', created_at: now },
      { id: 'd3', affects: ['auth'], summary: 'a3', type: 'decision', created_at: now },
      { id: 'd4', affects: ['billing'], summary: 'b1', type: 'decision', created_at: now },
      { id: 'd5', affects: ['billing'], summary: 'b2', type: 'decision', created_at: now },
      { id: 'd6', affects: ['billing'], summary: 'b3', type: 'decision', created_at: now },
    ];

    const supabase = createMockSupabase(() => mockQueryChain(decisions));

    const result = await detectPatterns(supabase as any, 'test-org', {
      windowDays: 30,
      minCluster: 3,
    });

    expect(result.length).toBeGreaterThanOrEqual(2);
    const allAffects = result.flatMap((c) => c.affects);
    expect(allAffects).toContain('auth');
    expect(allAffects).toContain('billing');
  });
});

// ---------------------------------------------------------------------------
// runSynthesis — idempotency (T063) and stale deprecation (T066)
// ---------------------------------------------------------------------------

describe('runSynthesis', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStoreDecision.mockResolvedValue({
      id: 'new-pattern-id',
      org_id: 'test-org',
      type: 'pattern',
      detail: 'Team pattern: auth — 3 decisions in 30 days',
      status: 'active',
      author: 'system',
      source: 'synthesis',
      content_hash: 'hash123',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      affects: ['auth'],
      depends_on: ['d1', 'd2', 'd3'],
      summary: 'Team pattern: auth — 3 decisions in 30 days',
    });
    mockChangeDecisionStatus.mockResolvedValue({
      id: 'stale-pattern-id',
      status: 'deprecated',
    });
  });

  it('dry-run reports candidates without creating patterns', async () => {
    const now = new Date().toISOString();
    const decisions = [
      { id: 'd1', affects: ['auth'], summary: 'a1', type: 'decision', created_at: now },
      { id: 'd2', affects: ['auth'], summary: 'a2', type: 'decision', created_at: now },
      { id: 'd3', affects: ['auth'], summary: 'a3', type: 'decision', created_at: now },
    ];

    const supabase = createMockSupabase(() => mockQueryChain(decisions));

    const report = await runSynthesis(supabase as any, 'test-org', {
      windowDays: 30,
      minCluster: 3,
      dryRun: true,
    });

    expect(report.dry_run).toBe(true);
    expect(report.candidates.length).toBeGreaterThanOrEqual(1);
    expect(report.patterns_created).toBe(0);
    expect(mockStoreDecision).not.toHaveBeenCalled();
  });

  it('skips creation when existing pattern has >0.8 Jaccard overlap on depends_on', async () => {
    const now = new Date().toISOString();
    const decisions = [
      { id: 'd1', affects: ['auth'], summary: 'a1', type: 'decision', created_at: now },
      { id: 'd2', affects: ['auth'], summary: 'a2', type: 'decision', created_at: now },
      { id: 'd3', affects: ['auth'], summary: 'a3', type: 'decision', created_at: now },
    ];

    let callCount = 0;
    const supabase = {
      from: vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          // detectPatterns: returns decisions
          return mockQueryChain(decisions);
        }
        // idempotency check + stale pattern: existing pattern matches
        return mockQueryChain([
          {
            id: 'existing-pattern',
            depends_on: ['d1', 'd2', 'd3'],
            affects: ['auth'],
          },
        ]);
      }),
    };

    const report = await runSynthesis(supabase as any, 'test-org', {
      windowDays: 30,
      minCluster: 3,
      dryRun: false,
    });

    // Should be skipped due to idempotency
    expect(report.patterns_created).toBe(0);
    expect(mockStoreDecision).not.toHaveBeenCalled();
  });

  it('creates new patterns when no existing overlap', async () => {
    const now = new Date().toISOString();
    const decisions = [
      { id: 'd1', affects: ['auth'], summary: 'a1', type: 'decision', created_at: now },
      { id: 'd2', affects: ['auth'], summary: 'a2', type: 'decision', created_at: now },
      { id: 'd3', affects: ['auth'], summary: 'a3', type: 'decision', created_at: now },
    ];

    let callCount = 0;
    const supabase = {
      from: vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          // detectPatterns: returns decisions
          return mockQueryChain(decisions);
        }
        if (callCount === 2) {
          // idempotency check: no existing patterns
          return mockQueryChain([]);
        }
        // Stale pattern check or count: empty
        return mockQueryChain([], null);
      }),
    };

    const report = await runSynthesis(supabase as any, 'test-org', {
      windowDays: 30,
      minCluster: 3,
      dryRun: false,
    });

    expect(report.patterns_created).toBe(1);
    expect(mockStoreDecision).toHaveBeenCalled();
    expect(mockCreateAuditEntry).toHaveBeenCalled();
  });

  it('deprecates stale patterns when all sources are deprecated', async () => {
    let callCount = 0;
    const supabase = {
      from: vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          // detectPatterns: no decisions in window
          return mockQueryChain([]);
        }
        if (callCount === 2) {
          // deprecateStalePatterns: find existing synthesis patterns
          return mockQueryChain([
            { id: 'stale-pattern', depends_on: ['d10', 'd11'] },
          ]);
        }
        if (callCount === 3) {
          // Check source decisions — all deprecated
          return mockQueryChain([
            { id: 'd10', status: 'deprecated' },
            { id: 'd11', status: 'superseded' },
          ]);
        }
        return mockQueryChain([]);
      }),
    };

    const report = await runSynthesis(supabase as any, 'test-org', {
      windowDays: 30,
      minCluster: 3,
      dryRun: false,
    });

    expect(report.patterns_deprecated).toBe(1);
    expect(mockChangeDecisionStatus).toHaveBeenCalledWith(
      expect.anything(),
      'test-org',
      'stale-pattern',
      'deprecated',
      'system',
      'All source decisions deprecated',
    );
  });
});
