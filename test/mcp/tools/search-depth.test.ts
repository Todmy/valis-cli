/**
 * Integration test for `valis_search` with `depth >= 1` (031/Track 5b).
 *
 * Mocks supabase + the search transport to verify the END-TO-END wiring:
 *   handleSearch → rerank → enrichWithRelated → walkEdges → summary lookup
 *
 * The unit tests in `edge-walker.test.ts` already cover the walker in
 * isolation. This file covers the gap: the `enrichWithRelated` call inside
 * handleSearch, the supabase loader bound to `decision_edges`, the summary
 * join via `getDecisionsByIds`, and the response-shape contract.
 *
 * Particularly covers:
 *   - depth=0 (or omitted): response shape is byte-identical to pre-slice
 *   - depth=1: each hit carries `related: [{decision_id, edge_type, depth, reason, summary?}]`
 *   - Non-blocking (Constitution III): supabase failure → `related: []` per hit, search still returns
 *   - Summary mode (default): related entries carry the summary field
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { hybridSearchMock, getDecisionsByIdsMock, fromMock, decisionEdgesQueue } =
  vi.hoisted(() => ({
    hybridSearchMock: vi.fn(),
    getDecisionsByIdsMock: vi.fn(),
    fromMock: vi.fn(),
    decisionEdgesQueue: { values: [] as Array<{ data: unknown; error: unknown }> },
  }));

// Build a thenable query-builder mock that supports an arbitrary `.select/.eq/.in`
// chain. Each builder method returns the same builder (so multi-`.in()` calls
// don't blow up), and `await builder` consumes the next queued response from
// `decisionEdgesQueue` (or a default empty result if the queue is empty).
function createQueryBuilder(): unknown {
  const builder: Record<string, unknown> = {};
  const chainable = () => builder;
  builder.select = chainable;
  builder.eq = chainable;
  builder.in = chainable;
  builder.then = (
    resolve: (v: { data: unknown; error: unknown }) => unknown,
    reject?: (e: unknown) => unknown,
  ) => {
    const next = decisionEdgesQueue.values.shift() ?? { data: [], error: null };
    try {
      const result = (next as { error?: Error | null | unknown }).error instanceof Error
        ? Promise.reject((next as { error: Error }).error)
        : Promise.resolve(next);
      return result.then(resolve, reject);
    } catch (err) {
      return reject ? reject(err) : Promise.reject(err);
    }
  };
  return builder;
}

vi.mock('../../../src/config/store.js', () => ({
  loadConfig: vi.fn().mockResolvedValue({
    org_id: 'org-1',
    member_id: 'm-1',
    auth_mode: 'service_role',
    supabase_url: 'https://test.supabase.co',
    supabase_service_role_key: 'srk',
    qdrant_url: 'https://test.qdrant.io',
    qdrant_api_key: 'qk',
  }),
}));

vi.mock('../../../src/cloud/qdrant.js', () => ({
  getQdrantClient: vi.fn().mockReturnValue({}),
  hybridSearch: hybridSearchMock,
  hybridSearchAllProjects: vi.fn(),
  buildProjectFilter: vi.fn().mockReturnValue({ must: [] }),
  COLLECTION_NAME: 'decisions',
}));

vi.mock('../../../src/cloud/supabase.js', () => ({
  getSupabaseClient: vi.fn(() => ({ from: fromMock })),
  getSupabaseJwtClient: vi.fn(() => ({ from: fromMock })),
  listMemberProjects: vi.fn(),
  getDecisionsByIds: getDecisionsByIdsMock,
}));

vi.mock('../../../src/billing/usage.js', () => ({
  incrementUsage: vi.fn().mockResolvedValue(undefined),
  checkUsageBeforeSearch: vi.fn().mockResolvedValue({ allowed: true }),
}));

import { handleSearch } from '../../../src/mcp/tools/search.js';
import type { RerankedResult } from '../../../src/types.js';

/** Cast helper — runtime objects ARE RerankedResult (super-set of SearchResult). */
function asReranked(r: unknown): RerankedResult {
  return r as RerankedResult;
}

beforeEach(() => {
  vi.clearAllMocks();
  // Reset the response queue — each test pushes its own values via
  // queueEdgesResponse() below before invoking handleSearch.
  decisionEdgesQueue.values.length = 0;
  fromMock.mockImplementation(() => createQueryBuilder());

  hybridSearchMock.mockResolvedValue([
    {
      id: 'B',
      score: 0.9,
      type: 'decision',
      summary: 'Postgres choice',
      detail: 'We chose Postgres',
      author: 'olena',
      affects: ['database'],
      created_at: '2026-05-15T00:00:00Z',
      status: 'active',
      confidence: 0.8,
      pinned: false,
      depends_on: [],
    },
  ]);

  getDecisionsByIdsMock.mockResolvedValue([]);
});

describe('valis_search depth — backward compatibility (FR-010)', () => {
  it('omits `related` field entirely when depth is absent', async () => {
    const result = await handleSearch({ query: 'database' });
    expect(result.results).toHaveLength(1);
    expect(result.results[0]).not.toHaveProperty('related');
  });

  it('omits `related` field when depth=0', async () => {
    const result = await handleSearch({ query: 'database', depth: 0 });
    expect(result.results[0]).not.toHaveProperty('related');
  });
});

describe('valis_search depth=1 — neighbour expansion', () => {
  it('adds `related: []` when no edges exist (never undefined)', async () => {
    const result = await handleSearch({ query: 'database', depth: 1 });
    expect(asReranked(result.results[0]).related).toEqual([]);
  });

  it('populates `related` with one neighbour when an outgoing edge exists', async () => {
    // Source: B → A (A is what B superseded)
    decisionEdgesQueue.values.push({
      data: [
        {
          from_id: 'B',
          to_id: 'A',
          type: 'supersedes',
          reason: 'A was MongoDB',
        },
      ],
      error: null,
    });
    // Summary lookup returns A's decision body.
    getDecisionsByIdsMock.mockResolvedValueOnce([
      { id: 'A', summary: 'MongoDB choice' },
    ]);

    const result = await handleSearch({ query: 'database', depth: 1 });
    expect(asReranked(result.results[0]).related).toEqual([
      {
        decision_id: 'A',
        edge_type: 'supersedes',
        depth: 1,
        reason: 'A was MongoDB',
        summary: 'MongoDB choice',
      },
    ]);
  });

  it('summary defaults to null when the related decision has no summary row', async () => {
    decisionEdgesQueue.values.push({
      data: [
        {
          from_id: 'B',
          to_id: 'unknown_id',
          type: 'builds_on',
          reason: null,
        },
      ],
      error: null,
    });
    // Summary lookup returns empty (unknown_id was deleted out-of-band).
    getDecisionsByIdsMock.mockResolvedValueOnce([]);

    const result = await handleSearch({ query: 'database', depth: 1 });
    expect(asReranked(result.results[0]).related?.[0]).toEqual({
      decision_id: 'unknown_id',
      edge_type: 'builds_on',
      depth: 1,
      reason: null,
      summary: null,
    });
  });
});

describe('valis_search depth=1 — full mode', () => {
  it('omits the summary key from related entries when mode=full', async () => {
    decisionEdgesQueue.values.push({
      data: [
        { from_id: 'B', to_id: 'A', type: 'supersedes', reason: 'r' },
      ],
      error: null,
    });
    getDecisionsByIdsMock.mockResolvedValueOnce([
      { id: 'A', summary: 'should not appear' },
    ]);

    const result = await handleSearch({ query: 'database', depth: 1, mode: 'full' });
    expect(asReranked(result.results[0]).related?.[0]).toEqual({
      decision_id: 'A',
      edge_type: 'supersedes',
      depth: 1,
      reason: 'r',
    });
    expect(asReranked(result.results[0]).related?.[0]).not.toHaveProperty('summary');
  });
});

describe('valis_search depth — non-blocking failure (Constitution III)', () => {
  it('falls back to related:[] on every hit when supabase throws', async () => {
    // Queue an error response — the builder mock will reject the promise.
    decisionEdgesQueue.values.push({
      data: null,
      error: new Error('supabase unreachable'),
    });

    const result = await handleSearch({ query: 'database', depth: 1 });
    // Parent search STILL returns the hit. `related` is `[]`, not absent.
    expect(result.results).toHaveLength(1);
    expect((result.results[0] as { related?: unknown[] }).related).toEqual([]);
  });

  it('still surfaces hits when summary lookup throws (degraded but useful)', async () => {
    decisionEdgesQueue.values.push({
      data: [
        { from_id: 'B', to_id: 'A', type: 'supersedes', reason: 'r' },
      ],
      error: null,
    });
    getDecisionsByIdsMock.mockRejectedValueOnce(new Error('decisions lookup failed'));

    const result = await handleSearch({ query: 'database', depth: 1 });
    // Search succeeds; summary degrades to null since the lookup failed.
    expect(result.results).toHaveLength(1);
    expect(asReranked(result.results[0]).related?.[0]).toEqual({
      decision_id: 'A',
      edge_type: 'supersedes',
      depth: 1,
      reason: 'r',
      summary: null,
    });
  });
});

describe('valis_search depth=2 — multi-level walk', () => {
  it('returns depth-1 and depth-2 neighbours each with their correct depth attribution', async () => {
    // Level 1: B → A
    decisionEdgesQueue.values.push({
      data: [{ from_id: 'B', to_id: 'A', type: 'supersedes', reason: 'level1' }],
      error: null,
    });
    // Level 2: A → origin (depth=2 frontier)
    decisionEdgesQueue.values.push({
      data: [
        { from_id: 'A', to_id: 'origin', type: 'builds_on', reason: 'level2' },
      ],
      error: null,
    });

    getDecisionsByIdsMock.mockResolvedValueOnce([
      { id: 'A', summary: 'Layer 1 neighbour' },
      { id: 'origin', summary: 'Layer 2 neighbour' },
    ]);

    const result = await handleSearch({ query: 'database', depth: 2 });
    const related = asReranked(result.results[0]).related!;
    expect(related).toHaveLength(2);
    expect(related[0]).toMatchObject({ decision_id: 'A', depth: 1 });
    expect(related[1]).toMatchObject({ decision_id: 'origin', depth: 2 });
  });
});
