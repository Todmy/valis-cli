/**
 * 031/Track 5b — EdgeWalker: bounded BFS over the `decision_edges` table.
 *
 * Pure data-layer module. Given a set of root decision ids, a depth cap
 * (`0 | 1 | 2`), and an optional edge-type filter, walks outgoing edges
 * level by level and returns the neighbourhood reachable within the cap.
 *
 * Contract guarantees:
 *
 *   - **Depth 0 is identity** (FR-002): empty neighbourhoods, zero DB calls.
 *     Used by `valis_search` as the backward-compatibility path when the
 *     caller omits the `depth` argument.
 *
 *   - **One DB call per depth level** (FR-003): each level's frontier ids
 *     are batched in a single `WHERE from_id = ANY($1)` query. No per-id
 *     round trips.
 *
 *   - **Visited-set deduplication** (FR-004): a node already reached at
 *     depth 1 is never re-expanded at depth 2, and appears in the output
 *     at most once — at the shallowest depth it was first seen.
 *
 *   - **Self-loop filter** (FR-013): rows with `from_id == to_id` are
 *     skipped at the application layer even if they exist in storage.
 *
 *   - **Edge-type filter** (FR-005): when `opts.edgeTypes` is supplied,
 *     only edges with `type IN (...)` are loaded.
 *
 * The module performs no authorisation, ranking, or response shaping —
 * callers (currently `valis_search` and `valis_evolve`'s round-trip test)
 * own those concerns. The walker is generic over a `loadEdgesByFrom`
 * function so unit tests can supply deterministic in-memory fixtures.
 */

export type EdgeType = 'supersedes' | 'builds_on' | 'synthesizes' | 'contradicts';

export interface DecisionEdge {
  from_id: string;
  to_id: string;
  type: EdgeType;
  reason: string | null;
}

export interface Neighbour {
  decision_id: string;
  edge_type: EdgeType;
  /** Depth at which this node was first reached (1 or 2 in this slice). */
  depth: 1 | 2;
  reason: string | null;
}

export interface EdgeNeighborhood {
  root_id: string;
  neighbours: Neighbour[];
}

export interface WalkOptions {
  depth: 0 | 1 | 2;
  edgeTypes?: EdgeType[];
}

/**
 * Loader port — given a set of frontier `from_id`s and an optional edge-type
 * filter, returns every matching `decision_edges` row. The implementation
 * lives in the caller (production: Supabase JWT client; tests: in-memory
 * fixture). The walker stays pure with respect to runtime state.
 */
export type LoadEdgesByFrom = (
  fromIds: string[],
  edgeTypes: EdgeType[] | undefined,
) => Promise<DecisionEdge[]>;

const ALL_EDGE_TYPES: EdgeType[] = [
  'supersedes',
  'builds_on',
  'synthesizes',
  'contradicts',
];

function validateDepth(d: number): asserts d is 0 | 1 | 2 {
  if (d !== 0 && d !== 1 && d !== 2) {
    throw new Error(`walkEdges: depth must be 0 | 1 | 2 (got ${d})`);
  }
}

/**
 * Walk the edge graph from each root id up to `opts.depth` levels.
 *
 * The walker is responsible only for the BFS shape — it does NOT decorate
 * neighbours with decision summaries or apply payload mode. Callers that
 * need the summary field do a follow-up join after the walk completes.
 */
export async function walkEdges(
  rootIds: string[],
  opts: WalkOptions,
  load: LoadEdgesByFrom,
): Promise<EdgeNeighborhood[]> {
  validateDepth(opts.depth);

  // FR-002 — depth=0 is identity, no DB call.
  if (opts.depth === 0 || rootIds.length === 0) {
    return rootIds.map((id) => ({ root_id: id, neighbours: [] }));
  }

  const edgeTypeFilter = opts.edgeTypes && opts.edgeTypes.length > 0
    ? opts.edgeTypes
    : ALL_EDGE_TYPES;

  // Per-root accumulators so the output is shape-stable.
  const perRoot = new Map<string, Neighbour[]>();
  const visited = new Map<string, Set<string>>(); // root_id → visited node ids
  for (const id of rootIds) {
    perRoot.set(id, []);
    // The root itself counts as visited so a cycle returning to root
    // doesn't add it to its own `related` array.
    visited.set(id, new Set([id]));
  }

  // Frontier tracking: which root each frontier id was reached from.
  // Multi-root walks share a single SQL call per depth level but the
  // results are attributed back to the originating root via this map.
  let frontiers: Array<{ rootId: string; nodeId: string }> = rootIds.map((id) => ({
    rootId: id,
    nodeId: id,
  }));

  for (let depthLevel: 1 | 2 = 1 as 1 | 2; depthLevel <= opts.depth; depthLevel = (depthLevel + 1) as 1 | 2) {
    if (frontiers.length === 0) break;

    // FR-003 — single DB call per depth level. Batch every frontier node id.
    const frontierIds = Array.from(new Set(frontiers.map((f) => f.nodeId)));
    const rows = await load(frontierIds, edgeTypeFilter);

    // Index rows by from_id for O(1) per-frontier lookup.
    const byFrom = new Map<string, DecisionEdge[]>();
    for (const row of rows) {
      // FR-013 — drop self-loops at the application layer.
      if (row.from_id === row.to_id) continue;
      const bucket = byFrom.get(row.from_id) ?? [];
      bucket.push(row);
      byFrom.set(row.from_id, bucket);
    }

    const nextFrontiers: Array<{ rootId: string; nodeId: string }> = [];
    for (const f of frontiers) {
      const edges = byFrom.get(f.nodeId) ?? [];
      const visitedForRoot = visited.get(f.rootId)!;
      const acc = perRoot.get(f.rootId)!;
      for (const edge of edges) {
        if (visitedForRoot.has(edge.to_id)) continue;
        visitedForRoot.add(edge.to_id);
        acc.push({
          decision_id: edge.to_id,
          edge_type: edge.type,
          depth: depthLevel,
          reason: edge.reason,
        });
        if (depthLevel < opts.depth) {
          nextFrontiers.push({ rootId: f.rootId, nodeId: edge.to_id });
        }
      }
    }
    frontiers = nextFrontiers;
  }

  return rootIds.map((id) => ({
    root_id: id,
    neighbours: perRoot.get(id) ?? [],
  }));
}
