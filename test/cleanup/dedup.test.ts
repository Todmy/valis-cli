/**
 * Unit tests for dedup — T027 (US3)
 *
 * Tests exact hash match detection, near-duplicate flagging,
 * protection rules (pinned, dependents), and symmetric pair dedup.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  findExactDuplicates,
  findNearDuplicates,
  deduplicateCandidates,
  type DedupCandidate,
} from '../../src/cleanup/dedup.js';

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function createMockSupabase(decisions: Record<string, unknown>[]) {
  const selectChain = {
    eq: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    not: vi.fn().mockReturnThis(),
    then: undefined as unknown,
  };

  // We need two different query chains: one for "active decisions" and one
  // for "depends_on not null".  We differentiate by tracking calls.
  let callCount = 0;

  const from = vi.fn().mockImplementation(() => {
    callCount++;
    // First call: active decisions query (for findExactDuplicates)
    // Second call: depends_on not null query
    const chain = {
      select: vi.fn().mockImplementation(() => {
        const inner = {
          eq: vi.fn().mockReturnThis(),
          order: vi.fn().mockImplementation(() => ({
            // Return active decisions for the first call
            data: decisions,
            error: null,
          })),
          not: vi.fn().mockImplementation(() => ({
            // Return all decisions with depends_on for the second call
            data: decisions.filter(
              (d) => d.depends_on != null && (d.depends_on as string[]).length > 0,
            ),
            error: null,
          })),
        };
        return inner;
      }),
    };
    return chain;
  });

  return { from } as unknown as import('@supabase/supabase-js').SupabaseClient;
}

function createMockQdrant(
  queryResults: Map<string, Array<{ id: string; score: number }>>,
) {
  return {
    query: vi.fn().mockImplementation(
      (_collection: string, params: { query: string }) => {
        const results = queryResults.get(params.query) ?? [];
        return Promise.resolve({
          points: results.map((r) => ({
            id: r.id,
            score: r.score,
            payload: { org_id: 'org-1', status: 'active' },
          })),
        });
      },
    ),
  } as unknown as import('@qdrant/js-client-rest').QdrantClient;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Dedup Module', () => {
  describe('deduplicateCandidates', () => {
    it('removes symmetric pairs (A->B and B->A)', () => {
      const candidates: DedupCandidate[] = [
        { keepId: 'a', deprecateIds: ['b'], method: 'near_duplicate', similarity: 0.95 },
        { keepId: 'b', deprecateIds: ['a'], method: 'near_duplicate', similarity: 0.95 },
      ];

      const result = deduplicateCandidates(candidates);
      expect(result).toHaveLength(1);

      // The single result should contain both IDs
      const allIds = [result[0].keepId, ...result[0].deprecateIds].sort();
      expect(allIds).toEqual(['a', 'b']);
    });

    it('keeps non-overlapping candidates', () => {
      const candidates: DedupCandidate[] = [
        { keepId: 'a', deprecateIds: ['b'], method: 'near_duplicate', similarity: 0.95 },
        { keepId: 'c', deprecateIds: ['d'], method: 'near_duplicate', similarity: 0.92 },
      ];

      const result = deduplicateCandidates(candidates);
      expect(result).toHaveLength(2);
    });

    it('handles empty input', () => {
      expect(deduplicateCandidates([])).toEqual([]);
    });

    it('handles multiple deprecateIds with partial overlap', () => {
      const candidates: DedupCandidate[] = [
        { keepId: 'a', deprecateIds: ['b', 'c'], method: 'near_duplicate', similarity: 0.95 },
        { keepId: 'b', deprecateIds: ['a'], method: 'near_duplicate', similarity: 0.95 },
      ];

      const result = deduplicateCandidates(candidates);
      // First candidate: a->b already seen, a->c is new => keeps a->c
      // Second candidate: b->a same pair as a->b => dropped
      // Total should be the original plus the filtered one
      const totalDeprecateIds = result.reduce(
        (sum, c) => sum + c.deprecateIds.length,
        0,
      );
      // a->c is new, a->b is seen first, b->a is duplicate
      expect(totalDeprecateIds).toBeGreaterThanOrEqual(1);
    });
  });

  describe('findExactDuplicates', () => {
    it('detects decisions with the same content_hash', async () => {
      const decisions = [
        {
          id: 'newer',
          content_hash: 'hash-1',
          created_at: '2026-03-20T00:00:00Z',
          pinned: false,
          depends_on: [],
        },
        {
          id: 'older',
          content_hash: 'hash-1',
          created_at: '2026-03-19T00:00:00Z',
          pinned: false,
          depends_on: [],
        },
      ];

      const supabase = createMockSupabase(decisions);
      const result = await findExactDuplicates(supabase, 'org-1');

      expect(result).toHaveLength(1);
      expect(result[0].keepId).toBe('newer');
      expect(result[0].deprecateIds).toEqual(['older']);
      expect(result[0].method).toBe('exact_hash');
      expect(result[0].similarity).toBe(1.0);
    });

    it('keeps newest decision in a group of 3', async () => {
      const decisions = [
        {
          id: 'newest',
          content_hash: 'hash-1',
          created_at: '2026-03-22T00:00:00Z',
          pinned: false,
          depends_on: [],
        },
        {
          id: 'middle',
          content_hash: 'hash-1',
          created_at: '2026-03-21T00:00:00Z',
          pinned: false,
          depends_on: [],
        },
        {
          id: 'oldest',
          content_hash: 'hash-1',
          created_at: '2026-03-20T00:00:00Z',
          pinned: false,
          depends_on: [],
        },
      ];

      const supabase = createMockSupabase(decisions);
      const result = await findExactDuplicates(supabase, 'org-1');

      expect(result).toHaveLength(1);
      expect(result[0].keepId).toBe('newest');
      expect(result[0].deprecateIds).toContain('middle');
      expect(result[0].deprecateIds).toContain('oldest');
      expect(result[0].deprecateIds).toHaveLength(2);
    });

    it('does NOT deprecate pinned decisions', async () => {
      const decisions = [
        {
          id: 'newer',
          content_hash: 'hash-1',
          created_at: '2026-03-20T00:00:00Z',
          pinned: false,
          depends_on: [],
        },
        {
          id: 'older-pinned',
          content_hash: 'hash-1',
          created_at: '2026-03-19T00:00:00Z',
          pinned: true,
          depends_on: [],
        },
      ];

      const supabase = createMockSupabase(decisions);
      const result = await findExactDuplicates(supabase, 'org-1');

      // The pinned decision should not appear in deprecateIds
      expect(result).toHaveLength(0);
    });

    it('does NOT auto-deprecate decisions with inbound depends_on', async () => {
      const decisions = [
        {
          id: 'newer',
          content_hash: 'hash-1',
          created_at: '2026-03-20T00:00:00Z',
          pinned: false,
          depends_on: ['depended-upon'], // newer depends on depended-upon
        },
        {
          id: 'depended-upon',
          content_hash: 'hash-1',
          created_at: '2026-03-19T00:00:00Z',
          pinned: false,
          depends_on: [],
        },
      ];

      const supabase = createMockSupabase(decisions);
      const result = await findExactDuplicates(supabase, 'org-1');

      // depended-upon has an inbound depends_on reference (newer -> depended-upon)
      // so it should not be auto-deprecated
      expect(result).toHaveLength(0);
    });

    it('returns empty when no duplicates exist', async () => {
      const decisions = [
        {
          id: 'a',
          content_hash: 'hash-a',
          created_at: '2026-03-20T00:00:00Z',
          pinned: false,
          depends_on: [],
        },
        {
          id: 'b',
          content_hash: 'hash-b',
          created_at: '2026-03-19T00:00:00Z',
          pinned: false,
          depends_on: [],
        },
      ];

      const supabase = createMockSupabase(decisions);
      const result = await findExactDuplicates(supabase, 'org-1');
      expect(result).toHaveLength(0);
    });

    it('returns empty when no decisions exist', async () => {
      const supabase = createMockSupabase([]);
      const result = await findExactDuplicates(supabase, 'org-1');
      expect(result).toHaveLength(0);
    });

    it('handles multiple duplicate groups independently', async () => {
      const decisions = [
        {
          id: 'a-new',
          content_hash: 'hash-a',
          created_at: '2026-03-22T00:00:00Z',
          pinned: false,
          depends_on: [],
        },
        {
          id: 'a-old',
          content_hash: 'hash-a',
          created_at: '2026-03-20T00:00:00Z',
          pinned: false,
          depends_on: [],
        },
        {
          id: 'b-new',
          content_hash: 'hash-b',
          created_at: '2026-03-22T00:00:00Z',
          pinned: false,
          depends_on: [],
        },
        {
          id: 'b-old',
          content_hash: 'hash-b',
          created_at: '2026-03-20T00:00:00Z',
          pinned: false,
          depends_on: [],
        },
      ];

      const supabase = createMockSupabase(decisions);
      const result = await findExactDuplicates(supabase, 'org-1');

      expect(result).toHaveLength(2);
      const keepIds = result.map((c) => c.keepId).sort();
      expect(keepIds).toEqual(['a-new', 'b-new']);
    });
  });

  describe('findNearDuplicates', () => {
    it('flags decisions above the cosine threshold', async () => {
      const queryResults = new Map([
        ['d-1', [{ id: 'd-2', score: 0.95 }]],
      ]);

      const qdrant = createMockQdrant(queryResults);
      const decisions = [{ id: 'd-1' }] as import('../../src/types.js').Decision[];

      const result = await findNearDuplicates(qdrant, 'org-1', decisions, 0.9);

      expect(result).toHaveLength(1);
      expect(result[0].method).toBe('near_duplicate');
      expect(result[0].keepId).toBe('d-1');
      expect(result[0].deprecateIds).toContain('d-2');
      expect(result[0].similarity).toBe(0.95);
    });

    it('does NOT flag decisions below the threshold', async () => {
      const queryResults = new Map([
        ['d-1', [{ id: 'd-2', score: 0.85 }]],
      ]);

      const qdrant = createMockQdrant(queryResults);
      const decisions = [{ id: 'd-1' }] as import('../../src/types.js').Decision[];

      const result = await findNearDuplicates(qdrant, 'org-1', decisions, 0.9);
      expect(result).toHaveLength(0);
    });

    it('deduplicates symmetric pairs (A->B and B->A)', async () => {
      const queryResults = new Map([
        ['d-1', [{ id: 'd-2', score: 0.95 }]],
        ['d-2', [{ id: 'd-1', score: 0.95 }]],
      ]);

      const qdrant = createMockQdrant(queryResults);
      const decisions = [
        { id: 'd-1' },
        { id: 'd-2' },
      ] as import('../../src/types.js').Decision[];

      const result = await findNearDuplicates(qdrant, 'org-1', decisions, 0.9);

      // Should be deduplicated to 1 pair
      expect(result).toHaveLength(1);
    });

    it('handles empty decisions list', async () => {
      const qdrant = createMockQdrant(new Map());
      const result = await findNearDuplicates(qdrant, 'org-1', [], 0.9);
      expect(result).toHaveLength(0);
    });

    it('handles Qdrant query failure gracefully', async () => {
      const qdrant = {
        query: vi.fn().mockRejectedValue(new Error('Qdrant unavailable')),
      } as unknown as import('@qdrant/js-client-rest').QdrantClient;

      const decisions = [{ id: 'd-1' }] as import('../../src/types.js').Decision[];

      // Should not throw — individual failures are skipped
      const result = await findNearDuplicates(qdrant, 'org-1', decisions, 0.9);
      expect(result).toHaveLength(0);
    });

    it('reports multiple near-duplicate matches for one decision', async () => {
      const queryResults = new Map([
        ['d-1', [
          { id: 'd-2', score: 0.96 },
          { id: 'd-3', score: 0.92 },
        ]],
      ]);

      const qdrant = createMockQdrant(queryResults);
      const decisions = [{ id: 'd-1' }] as import('../../src/types.js').Decision[];

      const result = await findNearDuplicates(qdrant, 'org-1', decisions, 0.9);

      expect(result).toHaveLength(1);
      expect(result[0].deprecateIds).toContain('d-2');
      expect(result[0].deprecateIds).toContain('d-3');
    });
  });
});
