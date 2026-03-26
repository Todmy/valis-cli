/**
 * Tests for semantic grouping — union-find clustering, representative
 * picking, action suggestion, and end-to-end findSemanticGroups.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  findSemanticGroups,
  pickRepresentative,
  suggestAction,
} from '../../src/cleanup/semantic-groups.js';
import type { Decision } from '../../src/types.js';

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

function makeDecision(overrides: Partial<Decision> & { id: string }): Decision {
  return {
    org_id: 'org-1',
    type: 'decision',
    summary: `Summary for ${overrides.id}`,
    detail: `Detail text for decision ${overrides.id}`,
    status: 'active',
    author: 'alice',
    source: 'mcp_store',
    project_id: 'proj-1',
    session_id: null,
    content_hash: `hash-${overrides.id}`,
    confidence: 0.5,
    affects: ['general'],
    created_at: '2026-03-20T00:00:00Z',
    updated_at: '2026-03-20T00:00:00Z',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// pickRepresentative
// ---------------------------------------------------------------------------

describe('pickRepresentative', () => {
  it('picks the decision with highest confidence', () => {
    const members = [
      makeDecision({ id: 'a', confidence: 0.5, created_at: '2026-03-20T00:00:00Z' }),
      makeDecision({ id: 'b', confidence: 0.9, created_at: '2026-03-19T00:00:00Z' }),
      makeDecision({ id: 'c', confidence: 0.3, created_at: '2026-03-21T00:00:00Z' }),
    ];

    const rep = pickRepresentative(members);
    expect(rep.id).toBe('b');
  });

  it('uses most recent as tiebreaker when confidence is equal', () => {
    const members = [
      makeDecision({ id: 'a', confidence: 0.8, created_at: '2026-03-19T00:00:00Z' }),
      makeDecision({ id: 'b', confidence: 0.8, created_at: '2026-03-22T00:00:00Z' }),
      makeDecision({ id: 'c', confidence: 0.8, created_at: '2026-03-20T00:00:00Z' }),
    ];

    const rep = pickRepresentative(members);
    expect(rep.id).toBe('b');
  });

  it('handles single member', () => {
    const members = [makeDecision({ id: 'a' })];
    expect(pickRepresentative(members).id).toBe('a');
  });

  it('treats null confidence as 0', () => {
    const members = [
      makeDecision({ id: 'a', confidence: null }),
      makeDecision({ id: 'b', confidence: 0.5 }),
    ];

    const rep = pickRepresentative(members);
    expect(rep.id).toBe('b');
  });
});

// ---------------------------------------------------------------------------
// suggestAction
// ---------------------------------------------------------------------------

describe('suggestAction', () => {
  it('returns merge for similarity > 0.9', () => {
    expect(suggestAction(0.95)).toBe('merge');
    expect(suggestAction(0.91)).toBe('merge');
    expect(suggestAction(1.0)).toBe('merge');
  });

  it('returns review for similarity 0.8-0.9', () => {
    expect(suggestAction(0.85)).toBe('review');
    expect(suggestAction(0.80)).toBe('review');
    expect(suggestAction(0.90)).toBe('review');
  });

  it('returns keep for similarity < 0.8', () => {
    expect(suggestAction(0.79)).toBe('keep');
    expect(suggestAction(0.70)).toBe('keep');
    expect(suggestAction(0.50)).toBe('keep');
  });
});

// ---------------------------------------------------------------------------
// findSemanticGroups (integration with mocks)
// ---------------------------------------------------------------------------

describe('findSemanticGroups', () => {
  function createMockSupabase(decisions: Decision[]) {
    return {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnThis(),
          order: vi.fn().mockReturnValue({
            data: decisions,
            error: null,
          }),
        }),
      }),
    } as unknown as import('@supabase/supabase-js').SupabaseClient;
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

  it('returns empty when no decisions exist', async () => {
    const supabase = createMockSupabase([]);
    const qdrant = createMockQdrant(new Map());

    const groups = await findSemanticGroups(qdrant, supabase, 'org-1');
    expect(groups).toHaveLength(0);
  });

  it('returns empty when no near-duplicates found', async () => {
    const decisions = [
      makeDecision({ id: 'd-1' }),
      makeDecision({ id: 'd-2' }),
    ];

    const supabase = createMockSupabase(decisions);
    // No results from qdrant = no similar decisions
    const qdrant = createMockQdrant(new Map());

    const groups = await findSemanticGroups(qdrant, supabase, 'org-1');
    expect(groups).toHaveLength(0);
  });

  it('groups connected near-duplicates into a single group', async () => {
    const decisions = [
      makeDecision({ id: 'd-1', confidence: 0.9, affects: ['auth'] }),
      makeDecision({ id: 'd-2', confidence: 0.5, affects: ['auth'] }),
      makeDecision({ id: 'd-3', confidence: 0.7, affects: ['auth'] }),
    ];

    // d-1 is similar to d-2 and d-3 (chain them)
    const queryResults = new Map([
      ['d-1', [{ id: 'd-2', score: 0.92 }, { id: 'd-3', score: 0.88 }]],
      ['d-2', [{ id: 'd-1', score: 0.92 }]],
      ['d-3', [{ id: 'd-1', score: 0.88 }]],
    ]);

    const supabase = createMockSupabase(decisions);
    const qdrant = createMockQdrant(queryResults);

    const groups = await findSemanticGroups(qdrant, supabase, 'org-1', {
      threshold: 0.7,
    });

    expect(groups).toHaveLength(1);
    expect(groups[0].members).toHaveLength(3);
    expect(groups[0].representative.id).toBe('d-1'); // highest confidence
  });

  it('assigns correct suggestedAction based on similarity', async () => {
    const decisions = [
      makeDecision({ id: 'd-1', confidence: 0.9 }),
      makeDecision({ id: 'd-2', confidence: 0.5 }),
    ];

    // High similarity = merge
    const queryResults = new Map([
      ['d-1', [{ id: 'd-2', score: 0.95 }]],
      ['d-2', [{ id: 'd-1', score: 0.95 }]],
    ]);

    const supabase = createMockSupabase(decisions);
    const qdrant = createMockQdrant(queryResults);

    const groups = await findSemanticGroups(qdrant, supabase, 'org-1', {
      threshold: 0.7,
    });

    expect(groups).toHaveLength(1);
    expect(groups[0].suggestedAction).toBe('merge');
    expect(groups[0].mergedSummary).toBeDefined();
  });

  it('generates mergedSummary only for merge groups', async () => {
    const decisions = [
      makeDecision({ id: 'd-1' }),
      makeDecision({ id: 'd-2' }),
    ];

    // Low similarity = keep
    const queryResults = new Map([
      ['d-1', [{ id: 'd-2', score: 0.72 }]],
      ['d-2', [{ id: 'd-1', score: 0.72 }]],
    ]);

    const supabase = createMockSupabase(decisions);
    const qdrant = createMockQdrant(queryResults);

    const groups = await findSemanticGroups(qdrant, supabase, 'org-1', {
      threshold: 0.7,
    });

    expect(groups).toHaveLength(1);
    expect(groups[0].suggestedAction).toBe('keep');
    expect(groups[0].mergedSummary).toBeUndefined();
  });

  it('respects minGroupSize option', async () => {
    const decisions = [
      makeDecision({ id: 'd-1' }),
      makeDecision({ id: 'd-2' }),
    ];

    const queryResults = new Map([
      ['d-1', [{ id: 'd-2', score: 0.95 }]],
      ['d-2', [{ id: 'd-1', score: 0.95 }]],
    ]);

    const supabase = createMockSupabase(decisions);
    const qdrant = createMockQdrant(queryResults);

    // Require at least 3 members — so this pair is excluded
    const groups = await findSemanticGroups(qdrant, supabase, 'org-1', {
      threshold: 0.7,
      minGroupSize: 3,
    });

    expect(groups).toHaveLength(0);
  });

  it('creates separate groups for disconnected clusters', async () => {
    const decisions = [
      makeDecision({ id: 'd-1', affects: ['auth'] }),
      makeDecision({ id: 'd-2', affects: ['auth'] }),
      makeDecision({ id: 'd-3', affects: ['database'] }),
      makeDecision({ id: 'd-4', affects: ['database'] }),
    ];

    // Two separate pairs, not connected to each other
    const queryResults = new Map([
      ['d-1', [{ id: 'd-2', score: 0.92 }]],
      ['d-2', [{ id: 'd-1', score: 0.92 }]],
      ['d-3', [{ id: 'd-4', score: 0.88 }]],
      ['d-4', [{ id: 'd-3', score: 0.88 }]],
    ]);

    const supabase = createMockSupabase(decisions);
    const qdrant = createMockQdrant(queryResults);

    const groups = await findSemanticGroups(qdrant, supabase, 'org-1', {
      threshold: 0.7,
    });

    expect(groups).toHaveLength(2);
  });
});
