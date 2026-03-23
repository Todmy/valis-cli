import { loadConfig } from '../../config/store.js';
import { getQdrantClient, hybridSearch } from '../../cloud/qdrant.js';
import type { ContextResponse, SearchResult } from '../../types.js';

interface ContextArgs {
  task_description: string;
  files?: string[];
}

let firstCall = true;

export async function handleContext(args: ContextArgs): Promise<ContextResponse> {
  const config = await loadConfig();
  if (!config) {
    return {
      decisions: [],
      constraints: [],
      patterns: [],
      lessons: [],
      total_in_brain: 0,
      note: 'Not configured. Run `teamind init` first.',
    };
  }

  // Build query from task description + file names
  let query = args.task_description;
  if (args.files?.length) {
    const fileTerms = args.files
      .map((f) => f.split('/').pop()?.replace(/\.[^.]+$/, ''))
      .filter(Boolean)
      .join(' ');
    query = `${query} ${fileTerms}`;
  }

  try {
    const qdrant = getQdrantClient(config.qdrant_url, config.qdrant_api_key);
    const results = await hybridSearch(qdrant, config.org_id, query, { limit: 20 });

    // Group by type
    const grouped: Record<string, SearchResult[]> = {
      decision: [],
      constraint: [],
      pattern: [],
      lesson: [],
    };

    for (const r of results) {
      const type = r.type === 'pending' ? 'decision' : r.type;
      if (grouped[type]) {
        grouped[type].push(r);
      }
    }

    const totalInBrain = results.length;
    let note: string | undefined;

    if (firstCall) {
      note = `${totalInBrain} relevant decisions found in team brain. Use teamind_search for specific queries.`;
      firstCall = false;
    }

    return {
      decisions: grouped.decision,
      constraints: grouped.constraint,
      patterns: grouped.pattern,
      lessons: grouped.lesson,
      total_in_brain: totalInBrain,
      note,
    };
  } catch {
    return {
      decisions: [],
      constraints: [],
      patterns: [],
      lessons: [],
      total_in_brain: 0,
      offline: true,
    };
  }
}
