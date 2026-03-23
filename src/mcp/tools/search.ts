import { loadConfig } from '../../config/store.js';
import { getQdrantClient, hybridSearch } from '../../cloud/qdrant.js';
import type { SearchResponse, SearchResult, DecisionStatus } from '../../types.js';

interface SearchArgs {
  query: string;
  type?: 'decision' | 'constraint' | 'pattern' | 'lesson';
  limit?: number;
}

/** Status priority for ranking: lower = higher priority. */
const STATUS_PRIORITY: Record<DecisionStatus, number> = {
  active: 0,
  proposed: 1,
  deprecated: 2,
  superseded: 3,
};

/**
 * Sort results so that active/proposed decisions rank above deprecated/superseded
 * when scores are equal (or very close). A tolerance of 0.01 treats scores within
 * that range as "equal relevance".
 */
function rankByStatus(results: SearchResult[]): SearchResult[] {
  const SCORE_TOLERANCE = 0.01;
  return [...results].sort((a, b) => {
    const scoreDiff = (b.score ?? 0) - (a.score ?? 0);
    if (Math.abs(scoreDiff) > SCORE_TOLERANCE) return scoreDiff;
    const statusA = STATUS_PRIORITY[a.status || 'active'] ?? 1;
    const statusB = STATUS_PRIORITY[b.status || 'active'] ?? 1;
    return statusA - statusB;
  });
}

/**
 * Build a reverse-lookup map: for each decision ID that has been replaced,
 * record the ID of the decision that replaced it.
 *
 * The raw results from Qdrant carry a `replaces` field (the ID of the older
 * decision). We invert that so each older decision gets a `replaced_by` value.
 */
function buildReplacedByMap(
  results: Array<SearchResult & { replaces?: string | null }>,
): Map<string, string> {
  const map = new Map<string, string>();
  for (const r of results) {
    if (r.replaces) {
      map.set(r.replaces, r.id);
    }
  }
  return map;
}

export async function handleSearch(args: SearchArgs): Promise<SearchResponse> {
  const config = await loadConfig();
  if (!config) {
    return { results: [], note: 'Not configured. Run `teamind init` first.' };
  }

  try {
    const qdrant = getQdrantClient(config.qdrant_url, config.qdrant_api_key);
    const rawResults = await hybridSearch(qdrant, config.org_id, args.query, {
      type: args.type,
      limit: args.limit || 10,
    });

    // Build replaced_by reverse lookup from the `replaces` field in raw results
    const replacedByMap = buildReplacedByMap(
      rawResults as Array<SearchResult & { replaces?: string | null }>,
    );

    // Enrich each result with status and replaced_by
    const enriched: SearchResult[] = rawResults.map((r) => ({
      id: r.id,
      score: r.score,
      type: r.type,
      summary: r.summary,
      detail: r.detail,
      author: r.author,
      affects: r.affects,
      created_at: r.created_at,
      status: r.status || 'active',
      replaced_by: replacedByMap.get(r.id) ?? null,
    }));

    // Rank active decisions above deprecated/superseded at equal relevance
    const ranked = rankByStatus(enriched);

    return { results: ranked };
  } catch {
    return {
      results: [],
      offline: true,
      note: 'Cloud unavailable. Search offline.',
    };
  }
}
