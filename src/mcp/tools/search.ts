import { loadConfig } from '../../config/store.js';
import { getQdrantClient, hybridSearch } from '../../cloud/qdrant.js';
import type { SearchResponse } from '../../types.js';

interface SearchArgs {
  query: string;
  type?: 'decision' | 'constraint' | 'pattern' | 'lesson';
  limit?: number;
}

export async function handleSearch(args: SearchArgs): Promise<SearchResponse> {
  const config = await loadConfig();
  if (!config) {
    return { results: [], note: 'Not configured. Run `teamind init` first.' };
  }

  try {
    const qdrant = getQdrantClient(config.qdrant_url, config.qdrant_api_key);
    const results = await hybridSearch(qdrant, config.org_id, args.query, {
      type: args.type,
      limit: args.limit || 10,
    });

    return { results };
  } catch {
    return {
      results: [],
      offline: true,
      note: 'Cloud unavailable. Search offline.',
    };
  }
}
