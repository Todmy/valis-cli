import { loadConfig } from '../../config/store.js';
import { getQdrantClient, hybridSearch } from '../../cloud/qdrant.js';
import type { ContextResponse, SearchResult, DecisionStatus } from '../../types.js';

interface ContextArgs {
  task_description: string;
  files?: string[];
}

/** Statuses considered non-active (historical). */
const HISTORICAL_STATUSES: Set<DecisionStatus> = new Set(['deprecated', 'superseded']);

let firstCall = true;

export async function handleContext(args: ContextArgs): Promise<ContextResponse> {
  const config = await loadConfig();
  if (!config) {
    return {
      decisions: [],
      constraints: [],
      patterns: [],
      lessons: [],
      historical: [],
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

    // Separate active/proposed from deprecated/superseded
    const active: SearchResult[] = [];
    const historical: SearchResult[] = [];

    for (const r of results) {
      const status: DecisionStatus = r.status || 'active';
      if (HISTORICAL_STATUSES.has(status)) {
        historical.push(r);
      } else {
        active.push(r);
      }
    }

    // Group active results by type
    const grouped: Record<string, SearchResult[]> = {
      decision: [],
      constraint: [],
      pattern: [],
      lesson: [],
    };

    for (const r of active) {
      const type = r.type === 'pending' ? 'decision' : r.type;
      if (grouped[type]) {
        grouped[type].push(r);
      }
    }

    const totalInBrain = results.length;
    let note: string | undefined;

    if (firstCall) {
      const historicalNote =
        historical.length > 0
          ? ` (${historical.length} historical/superseded items also available)`
          : '';
      note = `${totalInBrain} relevant decisions found in team brain${historicalNote}. Use teamind_search for specific queries.`;
      firstCall = false;
    }

    return {
      decisions: grouped.decision,
      constraints: grouped.constraint,
      patterns: grouped.pattern,
      lessons: grouped.lesson,
      historical,
      total_in_brain: totalInBrain,
      note,
    };
  } catch {
    return {
      decisions: [],
      constraints: [],
      patterns: [],
      lessons: [],
      historical: [],
      total_in_brain: 0,
      offline: true,
    };
  }
}
