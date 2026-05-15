/**
 * Tests for `walkEdges` (031/Track 5b — EdgeWalker deep module).
 *
 * Pure-function tests over an in-memory edge fixture. Covers:
 *   - depth=0 identity (no DB calls)
 *   - depth=1/2 BFS correctness on a hand-built graph
 *   - one DB call per depth level (single batched query)
 *   - visited-set deduplication across depths
 *   - cycle termination
 *   - edge-type filter
 *   - self-loop suppression (FR-013)
 *   - depth validation
 */

import { describe, it, expect } from 'vitest';
import {
  walkEdges,
  type DecisionEdge,
  type EdgeType,
  type LoadEdgesByFrom,
} from '../../src/cloud/edge-walker.js';

function makeLoader(edges: DecisionEdge[]): {
  load: LoadEdgesByFrom;
  callCount: () => number;
  callArgs: () => Array<{ ids: string[]; types: EdgeType[] | undefined }>;
} {
  const calls: Array<{ ids: string[]; types: EdgeType[] | undefined }> = [];
  const load: LoadEdgesByFrom = async (ids, types) => {
    calls.push({ ids: [...ids], types: types ? [...types] : undefined });
    const idSet = new Set(ids);
    return edges.filter(
      (e) =>
        idSet.has(e.from_id) &&
        (!types || types.includes(e.type)),
    );
  };
  return {
    load,
    callCount: () => calls.length,
    callArgs: () => calls,
  };
}

describe('walkEdges — depth=0 identity', () => {
  it('returns empty neighbourhoods and issues zero DB calls', async () => {
    const { load, callCount } = makeLoader([
      { from_id: 'A', to_id: 'B', type: 'supersedes', reason: null },
    ]);
    const result = await walkEdges(['A', 'C'], { depth: 0 }, load);

    expect(result).toEqual([
      { root_id: 'A', neighbours: [] },
      { root_id: 'C', neighbours: [] },
    ]);
    expect(callCount()).toBe(0);
  });

  it('returns empty array when rootIds is empty (no DB call)', async () => {
    const { load, callCount } = makeLoader([]);
    const result = await walkEdges([], { depth: 1 }, load);
    expect(result).toEqual([]);
    expect(callCount()).toBe(0);
  });
});

describe('walkEdges — depth=1 BFS', () => {
  it('returns immediate neighbours at depth 1', async () => {
    const { load, callCount } = makeLoader([
      { from_id: 'A', to_id: 'B', type: 'supersedes', reason: 'because' },
      { from_id: 'A', to_id: 'C', type: 'builds_on', reason: null },
    ]);
    const result = await walkEdges(['A'], { depth: 1 }, load);

    expect(callCount()).toBe(1); // FR-003 — one DB call per depth level
    expect(result).toHaveLength(1);
    expect(result[0].root_id).toBe('A');
    expect(result[0].neighbours).toEqual([
      { decision_id: 'B', edge_type: 'supersedes', depth: 1, reason: 'because' },
      { decision_id: 'C', edge_type: 'builds_on', depth: 1, reason: null },
    ]);
  });

  it('returns empty neighbours when the root has no outgoing edges', async () => {
    const { load } = makeLoader([]);
    const result = await walkEdges(['lonely'], { depth: 1 }, load);
    expect(result[0].neighbours).toEqual([]);
  });
});

describe('walkEdges — depth=2 BFS', () => {
  it('reaches depth-2 nodes via depth-1 frontier (chain A→B→C)', async () => {
    const { load, callCount } = makeLoader([
      { from_id: 'A', to_id: 'B', type: 'supersedes', reason: 'r1' },
      { from_id: 'B', to_id: 'C', type: 'supersedes', reason: 'r2' },
    ]);
    const result = await walkEdges(['A'], { depth: 2 }, load);

    // FR-003 — exactly one call per depth level (2 levels = 2 calls).
    expect(callCount()).toBe(2);
    expect(result[0].neighbours).toEqual([
      { decision_id: 'B', edge_type: 'supersedes', depth: 1, reason: 'r1' },
      { decision_id: 'C', edge_type: 'supersedes', depth: 2, reason: 'r2' },
    ]);
  });

  it('batches multi-root frontiers in a single DB call per level', async () => {
    const { load, callCount, callArgs } = makeLoader([
      { from_id: 'A', to_id: 'B', type: 'supersedes', reason: null },
      { from_id: 'X', to_id: 'Y', type: 'builds_on', reason: null },
    ]);
    const result = await walkEdges(['A', 'X'], { depth: 1 }, load);

    expect(callCount()).toBe(1);
    expect(callArgs()[0].ids.sort()).toEqual(['A', 'X']);
    expect(result.map((r) => r.root_id)).toEqual(['A', 'X']);
    expect(result[0].neighbours.map((n) => n.decision_id)).toEqual(['B']);
    expect(result[1].neighbours.map((n) => n.decision_id)).toEqual(['Y']);
  });
});

describe('walkEdges — visited-set deduplication (FR-004)', () => {
  it('lists a node at most once even when reachable via multiple paths', async () => {
    // A→B, A→C, B→D, C→D — D is reachable at depth 2 from both B and C.
    const { load } = makeLoader([
      { from_id: 'A', to_id: 'B', type: 'supersedes', reason: null },
      { from_id: 'A', to_id: 'C', type: 'supersedes', reason: null },
      { from_id: 'B', to_id: 'D', type: 'supersedes', reason: 'via-B' },
      { from_id: 'C', to_id: 'D', type: 'supersedes', reason: 'via-C' },
    ]);
    const result = await walkEdges(['A'], { depth: 2 }, load);

    expect(result[0].neighbours.filter((n) => n.decision_id === 'D')).toHaveLength(1);
    expect(result[0].neighbours.find((n) => n.decision_id === 'D')!.depth).toBe(2);
  });

  it('terminates cleanly on a three-node cycle A→B→C→A within 100 ms', async () => {
    const { load } = makeLoader([
      { from_id: 'A', to_id: 'B', type: 'supersedes', reason: null },
      { from_id: 'B', to_id: 'C', type: 'supersedes', reason: null },
      { from_id: 'C', to_id: 'A', type: 'supersedes', reason: null },
    ]);
    const start = Date.now();
    const result = await walkEdges(['A'], { depth: 2 }, load);
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(100); // SC-003
    expect(result[0].neighbours.map((n) => n.decision_id)).toEqual(['B', 'C']);
    expect(result[0].neighbours.map((n) => n.depth)).toEqual([1, 2]);
  });
});

describe('walkEdges — self-loop suppression (FR-013)', () => {
  it('skips A→A rows entirely — no expansion, no entry in related', async () => {
    const { load } = makeLoader([
      { from_id: 'A', to_id: 'A', type: 'supersedes', reason: 'self' },
      { from_id: 'A', to_id: 'B', type: 'builds_on', reason: null },
    ]);
    const result = await walkEdges(['A'], { depth: 1 }, load);

    expect(result[0].neighbours.map((n) => n.decision_id)).toEqual(['B']);
  });
});

describe('walkEdges — edge-type filter (FR-005)', () => {
  it('restricts traversal to the supplied edge types', async () => {
    const { load, callArgs } = makeLoader([
      { from_id: 'A', to_id: 'B', type: 'supersedes', reason: null },
      { from_id: 'A', to_id: 'C', type: 'contradicts', reason: null },
    ]);
    const result = await walkEdges(
      ['A'],
      { depth: 1, edgeTypes: ['supersedes'] },
      load,
    );

    expect(result[0].neighbours.map((n) => n.decision_id)).toEqual(['B']);
    expect(callArgs()[0].types).toEqual(['supersedes']);
  });

  it('traverses every type when edgeTypes is omitted', async () => {
    const { load, callArgs } = makeLoader([
      { from_id: 'A', to_id: 'B', type: 'supersedes', reason: null },
      { from_id: 'A', to_id: 'C', type: 'contradicts', reason: null },
    ]);
    const result = await walkEdges(['A'], { depth: 1 }, load);

    expect(result[0].neighbours.map((n) => n.decision_id).sort()).toEqual(['B', 'C']);
    expect(callArgs()[0].types).toEqual([
      'supersedes',
      'builds_on',
      'synthesizes',
      'contradicts',
    ]);
  });

  it('returns empty when no edges match the filter', async () => {
    const { load } = makeLoader([
      { from_id: 'A', to_id: 'B', type: 'supersedes', reason: null },
    ]);
    const result = await walkEdges(
      ['A'],
      { depth: 1, edgeTypes: ['synthesizes'] },
      load,
    );
    expect(result[0].neighbours).toEqual([]);
  });
});

describe('walkEdges — depth validation (FR-014)', () => {
  it('throws when depth > 2', async () => {
    const { load } = makeLoader([]);
    await expect(
      walkEdges(['A'], { depth: 3 as unknown as 0 | 1 | 2 }, load),
    ).rejects.toThrow(/depth/i);
  });

  it('throws when depth is negative', async () => {
    const { load } = makeLoader([]);
    await expect(
      walkEdges(['A'], { depth: -1 as unknown as 0 | 1 | 2 }, load),
    ).rejects.toThrow(/depth/i);
  });
});
