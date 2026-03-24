import { loadConfig } from '../../config/store.js';
import { getQdrantClient, hybridSearch } from '../../cloud/qdrant.js';
import { rerank } from '../../search/reranker.js';
import { suppressResults } from '../../search/suppression.js';
import type { RerankedSearchResponse, SearchResult, DecisionStatus } from '../../types.js';

interface SearchArgs {
  query: string;
  type?: 'decision' | 'constraint' | 'pattern' | 'lesson';
  limit?: number;
  /** When true, include suppressed results with `suppressed` label. */
  all?: boolean;
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

export async function handleSearch(args: SearchArgs): Promise<RerankedSearchResponse> {
  const config = await loadConfig();
  if (!config) {
    return { results: [], suppressed_count: 0, note: 'Not configured. Run `teamind init` first.' };
  }

  try {
    const qdrant = getQdrantClient(config.qdrant_url, config.qdrant_api_key);

    // T046: Fetch up to 50 results for reranking (overfetch, then slice to requested limit)
    const rawResults = await hybridSearch(qdrant, config.org_id, args.query, {
      type: args.type,
      limit: 50,
    });

    // Build replaced_by reverse lookup from the `replaces` field in raw results
    const replacedByMap = buildReplacedByMap(
      rawResults as Array<SearchResult & { replaces?: string | null }>,
    );

    // Enrich each result with replaced_by and status_label
    const enriched: SearchResult[] = rawResults.map((r) => {
      const status: DecisionStatus = r.status || 'active';
      const result: SearchResult = {
        ...r,
        status,
        replaced_by: replacedByMap.get(r.id) ?? null,
      };
      // Attach a human-readable label for non-active statuses
      if (status !== 'active') {
        result.status_label = status;
      }
      return result;
    });

    // T046: Replace rankByStatus with multi-signal reranking
    const reranked = rerank(enriched);

    // T049: Apply within-area suppression after reranking
    const { visible, suppressed_count } = suppressResults(
      reranked,
      1.5,
      args.all ?? false,
    );

    // Slice to requested limit
    const finalResults = visible.slice(0, args.limit || 10);

    return { results: finalResults, suppressed_count };
  } catch {
    return {
      results: [],
      suppressed_count: 0,
      offline: true,
      note: 'Cloud unavailable. Search offline.',
    };
  }
}
