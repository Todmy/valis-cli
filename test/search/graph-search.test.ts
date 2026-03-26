import { describe, it, expect, vi } from 'vitest';
import {
  collectNeighborIds,
  buildSupersessionChains,
  attachSupersessionChains,
  expandWithNeighbors,
  graphAugmentedSearch,
} from '../../src/search/graph-search.js';
import type { SearchResult } from '../../src/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeResult(
  overrides: Partial<SearchResult> & { id: string },
): SearchResult {
  return {
    score: 0.8,
    type: 'decision',
    summary: 'test',
    detail: 'test detail',
    author: 'alice',
    affects: ['api'],
    created_at: '2026-03-24T00:00:00Z',
    status: 'active',
    depends_on: [],
    ...overrides,
  };
}

function makeMockQdrant(
  points: Array<{ id: string; payload: Record<string, unknown> }>,
) {
  return {
    retrieve: vi.fn().mockResolvedValue(
      points.map((p) => ({ id: p.id, payload: p.payload })),
    ),
  } as unknown as import('@qdrant/js-client-rest').QdrantClient;
}

// ---------------------------------------------------------------------------
// collectNeighborIds
// ---------------------------------------------------------------------------

describe('collectNeighborIds', () => {
  it('returns empty array when no external references exist', () => {
    const results = [
      makeResult({ id: 'a', depends_on: ['b'] }),
      makeResult({ id: 'b', depends_on: [] }),
    ];
    expect(collectNeighborIds(results)).toEqual([]);
  });

  it('returns IDs from depends_on that are not in the result set', () => {
    const results = [
      makeResult({ id: 'a', depends_on: ['ext-1', 'b'] }),
      makeResult({ id: 'b', depends_on: ['ext-2'] }),
    ];
    const ids = collectNeighborIds(results);
    expect(ids.sort()).toEqual(['ext-1', 'ext-2']);
  });

  it('returns IDs from replaced_by that are not in the result set', () => {
    const results = [
      makeResult({ id: 'a', replaced_by: 'ext-3' }),
    ];
    const ids = collectNeighborIds(results);
    expect(ids).toEqual(['ext-3']);
  });

  it('deduplicates neighbor IDs', () => {
    const results = [
      makeResult({ id: 'a', depends_on: ['ext-1'] }),
      makeResult({ id: 'b', depends_on: ['ext-1'] }),
    ];
    const ids = collectNeighborIds(results);
    expect(ids).toEqual(['ext-1']);
  });

  it('does not include IDs already in the result set', () => {
    const results = [
      makeResult({ id: 'a', depends_on: ['b'], replaced_by: 'b' }),
      makeResult({ id: 'b' }),
    ];
    expect(collectNeighborIds(results)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// expandWithNeighbors
// ---------------------------------------------------------------------------

describe('expandWithNeighbors', () => {
  it('tags original results with graph_hop: 0 when no neighbors', async () => {
    const results = [makeResult({ id: 'a', depends_on: [] })];
    const qdrant = makeMockQdrant([]);
    const expanded = await expandWithNeighbors(qdrant, results, 'org-1');
    expect(expanded).toHaveLength(1);
    expect(expanded[0].graph_hop).toBe(0);
  });

  it('fetches and appends 1-hop neighbors', async () => {
    const results = [makeResult({ id: 'a', depends_on: ['ext-1'] })];
    const qdrant = makeMockQdrant([
      {
        id: 'ext-1',
        payload: {
          org_id: 'org-1',
          type: 'decision',
          detail: 'external decision',
          author: 'bob',
          affects: ['db'],
          created_at: '2026-03-20T00:00:00Z',
          status: 'active',
        },
      },
    ]);

    const expanded = await expandWithNeighbors(qdrant, results, 'org-1');
    expect(expanded).toHaveLength(2);
    expect(expanded[0].id).toBe('a');
    expect(expanded[0].graph_hop).toBe(0);
    expect(expanded[1].id).toBe('ext-1');
    expect(expanded[1].graph_hop).toBe(1);
    expect(expanded[1].detail).toBe('external decision');
  });

  it('filters out neighbors from other orgs', async () => {
    const results = [makeResult({ id: 'a', depends_on: ['ext-1'] })];
    const qdrant = makeMockQdrant([
      {
        id: 'ext-1',
        payload: {
          org_id: 'other-org',
          type: 'decision',
          detail: 'secret',
          author: 'eve',
          affects: [],
          created_at: '2026-03-20T00:00:00Z',
          status: 'active',
        },
      },
    ]);

    const expanded = await expandWithNeighbors(qdrant, results, 'org-1');
    expect(expanded).toHaveLength(1);
  });

  it('handles Qdrant retrieval failure gracefully', async () => {
    const results = [makeResult({ id: 'a', depends_on: ['ext-1'] })];
    const qdrant = {
      retrieve: vi.fn().mockRejectedValue(new Error('connection failed')),
    } as unknown as import('@qdrant/js-client-rest').QdrantClient;

    const expanded = await expandWithNeighbors(qdrant, results, 'org-1');
    expect(expanded).toHaveLength(1);
    expect(expanded[0].graph_hop).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// buildSupersessionChains
// ---------------------------------------------------------------------------

describe('buildSupersessionChains', () => {
  it('returns empty map when no replacements exist', () => {
    const results = [makeResult({ id: 'a' }), makeResult({ id: 'b' })];
    const chains = buildSupersessionChains(results);
    expect(chains.size).toBe(0);
  });

  it('builds a simple chain: c replaces b replaces a', () => {
    const results = [
      makeResult({ id: 'a' }),
      makeResult({ id: 'b', replaced_by: 'a' }),
      makeResult({ id: 'c', replaced_by: 'b' }),
    ];
    const chains = buildSupersessionChains(results);
    expect(chains.get('c')).toEqual(['a', 'b']);
    expect(chains.get('b')).toEqual(['a']);
    expect(chains.has('a')).toBe(false);
  });

  it('handles single replacement', () => {
    const results = [
      makeResult({ id: 'old' }),
      makeResult({ id: 'new', replaced_by: 'old' }),
    ];
    const chains = buildSupersessionChains(results);
    expect(chains.get('new')).toEqual(['old']);
  });

  it('handles circular references without infinite loop', () => {
    const results = [
      makeResult({ id: 'a', replaced_by: 'b' }),
      makeResult({ id: 'b', replaced_by: 'a' }),
    ];
    const chains = buildSupersessionChains(results);
    expect(chains.get('a')).toBeDefined();
    expect(chains.get('b')).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// attachSupersessionChains
// ---------------------------------------------------------------------------

describe('attachSupersessionChains', () => {
  it('attaches supersedes to results with replacement chains', () => {
    const results = [
      makeResult({ id: 'old' }),
      makeResult({ id: 'new', replaced_by: 'old' }),
    ];
    const enriched = attachSupersessionChains(results);
    const newResult = enriched.find((r) => r.id === 'new')!;
    expect(newResult.supersedes).toEqual(['old']);
    const oldResult = enriched.find((r) => r.id === 'old')!;
    expect(oldResult.supersedes).toBeUndefined();
  });

  it('leaves results without chains unchanged', () => {
    const results = [makeResult({ id: 'a' })];
    const enriched = attachSupersessionChains(results);
    expect(enriched[0].supersedes).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// graphAugmentedSearch (integration)
// ---------------------------------------------------------------------------

describe('graphAugmentedSearch', () => {
  it('combines neighbor expansion and supersession chains', async () => {
    const results = [
      makeResult({ id: 'v2', depends_on: ['dep-ext'], replaced_by: 'v1' }),
      makeResult({ id: 'v1' }),
    ];
    const qdrant = makeMockQdrant([
      {
        id: 'dep-ext',
        payload: {
          org_id: 'org-1',
          type: 'constraint',
          detail: 'external constraint',
          author: 'bob',
          affects: ['security'],
          created_at: '2026-03-15T00:00:00Z',
          status: 'active',
        },
      },
    ]);

    const enriched = await graphAugmentedSearch(qdrant, results, 'org-1');

    expect(enriched).toHaveLength(3);

    const v2 = enriched.find((r) => r.id === 'v2')!;
    expect(v2.graph_hop).toBe(0);
    expect(v2.supersedes).toEqual(['v1']);

    const ext = enriched.find((r) => r.id === 'dep-ext')!;
    expect(ext.graph_hop).toBe(1);
    expect(ext.type).toBe('constraint');
  });

  it('works with empty results', async () => {
    const qdrant = makeMockQdrant([]);
    const enriched = await graphAugmentedSearch(qdrant, [], 'org-1');
    expect(enriched).toEqual([]);
  });
});
