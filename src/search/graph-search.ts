/**
 * Graph-augmented search: expands initial search results with 1-hop
 * relationship neighbors and reconstructs supersession chains (from Q4-C).
 *
 * After hybridSearch returns top-N results, this module:
 *
 * 1. **1-hop neighbor expansion**: Looks at `depends_on` and `replaces` fields
 *    of each result. Fetches decisions that are referenced but not already in
 *    the result set. Marks them with `graph_hop: 1`.
 *
 * 2. **Supersession chain reconstruction**: For each result with `replaces`,
 *    follows the chain backward to build `supersedes: string[]` showing the
 *    full evolution of a decision.
 *
 * Both operations use a Qdrant `retrieve` call to batch-fetch missing points,
 * avoiding N+1 query patterns.
 *
 * @module search/graph-search
 */

import type { QdrantClient } from '@qdrant/js-client-rest';
import type { SearchResult, DecisionType, DecisionStatus } from '../types.js';
import { COLLECTION_NAME } from '../cloud/qdrant.js';

// ---------------------------------------------------------------------------
// 1-hop neighbor expansion
// ---------------------------------------------------------------------------

/**
 * Collect all decision IDs referenced by `depends_on` and `replaces` fields
 * in the given results that are NOT already in the result set.
 */
export function collectNeighborIds(results: SearchResult[]): string[] {
  const resultIds = new Set(results.map((r) => r.id));
  const neighborIds = new Set<string>();

  for (const r of results) {
    // Outbound deps: decisions this result depends on
    if (r.depends_on) {
      for (const depId of r.depends_on) {
        if (!resultIds.has(depId)) neighborIds.add(depId);
      }
    }
    // Supersession: the decision this one replaced
    if (r.replaced_by && !resultIds.has(r.replaced_by)) {
      neighborIds.add(r.replaced_by);
    }
  }

  return [...neighborIds];
}

/**
 * Map a raw Qdrant point payload to a SearchResult with `graph_hop: 1`.
 */
function mapNeighborPoint(
  point: { id: string | number; payload?: Record<string, unknown> | null },
): SearchResult {
  const payload = (point.payload ?? {}) as Record<string, unknown>;
  return {
    id: point.id as string,
    score: 0, // not from vector search — no semantic score
    type: (payload.type as DecisionType) ?? 'pending',
    summary: (payload.summary as string) || null,
    detail: (payload.detail as string) || '',
    author: (payload.author as string) || '',
    affects: (payload.affects as string[]) || [],
    created_at: (payload.created_at as string) || '',
    status: (payload.status as DecisionStatus) || 'active',
    replaced_by: (payload.replaces as string) || null,
    confidence: (payload.confidence as number) ?? null,
    pinned: (payload.pinned as boolean) ?? false,
    depends_on: (payload.depends_on as string[]) ?? [],
    project_id: (payload.project_id as string) ?? undefined,
    project_name: (payload.project_name as string) ?? undefined,
    graph_hop: 1,
  };
}

/**
 * Expand search results with 1-hop graph neighbors.
 *
 * Fetches decisions referenced by `depends_on` and `replaces` that aren't
 * already in the result set. Returns the original results (with `graph_hop: 0`)
 * plus any new neighbors (with `graph_hop: 1`).
 *
 * @param qdrant  Qdrant client.
 * @param results  Initial search results.
 * @param orgId  Organization ID for security validation.
 * @returns Expanded result set. Original results are first, neighbors appended.
 */
export async function expandWithNeighbors(
  qdrant: QdrantClient,
  results: SearchResult[],
  orgId: string,
): Promise<SearchResult[]> {
  const neighborIds = collectNeighborIds(results);
  if (neighborIds.length === 0) {
    // Tag originals with graph_hop: 0
    return results.map((r) => ({ ...r, graph_hop: 0 }));
  }

  let neighborResults: SearchResult[] = [];
  try {
    const points = await qdrant.retrieve(COLLECTION_NAME, {
      ids: neighborIds,
      with_payload: true,
    });

    // Filter to same org for security
    neighborResults = points
      .filter((p) => {
        const payload = p.payload as Record<string, unknown> | undefined;
        return payload?.org_id === orgId;
      })
      .map(mapNeighborPoint);
  } catch {
    // If retrieval fails, return original results only
  }

  const tagged = results.map((r) => ({ ...r, graph_hop: 0 as number }));
  return [...tagged, ...neighborResults];
}

// ---------------------------------------------------------------------------
// Supersession chain reconstruction
// ---------------------------------------------------------------------------

/**
 * Build a map of decision_id -> list of IDs it supersedes (the chain of
 * replaced decisions, oldest first).
 *
 * Uses only the data already available in the result set + fetched neighbors
 * to avoid extra round-trips. For each result that has `replaced_by` pointing
 * to another result in the set, we record the chain.
 *
 * The algorithm works in reverse: if result B has `replaced_by: A`, then A
 * supersedes B. We walk these chains to build the full supersession history.
 */
export function buildSupersessionChains(
  results: SearchResult[],
): Map<string, string[]> {
  // Note: SearchResult.replaced_by is mapped from the payload's `replaces` field,
  // so it actually means "this decision replaces <replaced_by>". We use it as
  // a forward pointer: decision -> the decision it replaced.
  const replacesMap = new Map<string, string>();

  for (const r of results) {
    if (r.replaced_by) {
      // This result replaces the decision with id `replaced_by`
      replacesMap.set(r.id, r.replaced_by);
    }
  }

  // For each decision, walk the `replaces` chain to build supersedes list
  const chains = new Map<string, string[]>();

  for (const r of results) {
    const chain: string[] = [];
    let currentId: string | undefined = replacesMap.get(r.id);

    // Walk the chain: this decision replaces X, X replaces Y, etc.
    const visited = new Set<string>();
    visited.add(r.id);

    while (currentId && !visited.has(currentId)) {
      chain.push(currentId);
      visited.add(currentId);
      // Check if the replaced decision also replaced something
      currentId = replacesMap.get(currentId);
    }

    if (chain.length > 0) {
      // Reverse so oldest is first
      chain.reverse();
      chains.set(r.id, chain);
    }
  }

  return chains;
}

/**
 * Attach supersession chains to search results.
 *
 * For each result that replaces another decision, populates the `supersedes`
 * field with the chain of decision IDs it superseded (oldest first).
 *
 * @param results  Search results (may include 1-hop neighbors).
 * @returns Results with `supersedes` populated where applicable.
 */
export function attachSupersessionChains(results: SearchResult[]): SearchResult[] {
  const chains = buildSupersessionChains(results);

  return results.map((r) => {
    const chain = chains.get(r.id);
    if (chain && chain.length > 0) {
      return { ...r, supersedes: chain };
    }
    return r;
  });
}

// ---------------------------------------------------------------------------
// Combined graph-augmented search pipeline
// ---------------------------------------------------------------------------

/**
 * Full graph-augmented search pipeline:
 * 1. Expand results with 1-hop neighbors
 * 2. Attach supersession chains
 *
 * @param qdrant  Qdrant client.
 * @param initialResults  Results from hybridSearch.
 * @param orgId  Organization ID.
 * @returns Enriched results with graph context.
 */
export async function graphAugmentedSearch(
  qdrant: QdrantClient,
  initialResults: SearchResult[],
  orgId: string,
): Promise<SearchResult[]> {
  // Step 1: Expand with 1-hop neighbors
  const expanded = await expandWithNeighbors(qdrant, initialResults, orgId);

  // Step 2: Attach supersession chains
  return attachSupersessionChains(expanded);
}
