import { loadConfig } from '../../config/store.js';
import { resolveConfig } from '../../config/project.js';
import { getQdrantClient, hybridSearch, hybridSearchAllProjects } from '../../cloud/qdrant.js';
import { getSupabaseClient, listMemberProjects } from '../../cloud/supabase.js';
import { rerank } from '../../search/reranker.js';
import { suppressResults } from '../../search/suppression.js';
import type { ContextResponse, RerankedResult, DecisionStatus } from '../../types.js';

interface ContextArgs {
  task_description: string;
  files?: string[];
  /** T022: When true, load context from all accessible projects. */
  all_projects?: boolean;
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

  // T022: Resolve project from per-directory config
  const resolved = await resolveConfig();
  const projectId = resolved.project?.project_id;

  try {
    const qdrant = getQdrantClient(config.qdrant_url, config.qdrant_api_key);
    let results;

    if (args.all_projects) {
      // T022: Cross-project context — load from all accessible projects
      let projectIds: string[] = [];
      try {
        if (config.member_id) {
          const supabase = getSupabaseClient(config.supabase_url, config.supabase_service_role_key);
          const projects = await listMemberProjects(supabase, config.member_id);
          projectIds = projects.map((p) => p.id);
        }
      } catch {
        // Fall back to org-wide
      }

      if (projectIds.length > 0) {
        results = await hybridSearchAllProjects(qdrant, config.org_id, query, projectIds, { limit: 50 });
      } else {
        results = await hybridSearch(qdrant, config.org_id, query, { limit: 50 });
      }
    } else {
      // T022: Default — context scoped to active project
      results = await hybridSearch(qdrant, config.org_id, query, { limit: 50, projectId });
    }

    // T047: Apply multi-signal reranking for consistent ordering with search
    const reranked: RerankedResult[] = rerank(results);

    // T050: Apply within-area suppression after reranking
    const { visible, suppressed_count } = suppressResults(reranked, 1.5, false);

    // Separate active/proposed from deprecated/superseded
    const active: RerankedResult[] = [];
    const historical: RerankedResult[] = [];

    for (const r of visible) {
      const status: DecisionStatus = r.status || 'active';
      if (HISTORICAL_STATUSES.has(status)) {
        historical.push(r);
      } else {
        active.push(r);
      }
    }

    // Group active results by type
    const grouped: Record<string, RerankedResult[]> = {
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

    // Limit each group to top results (already sorted by composite_score)
    const decisions = grouped.decision.slice(0, 20);
    const constraints = grouped.constraint.slice(0, 20);
    const patterns = grouped.pattern.slice(0, 20);
    const lessons = grouped.lesson.slice(0, 20);

    const totalInBrain = reranked.length;
    let note: string | undefined;

    if (firstCall) {
      const historicalNote =
        historical.length > 0
          ? ` (${historical.length} historical/superseded items also available)`
          : '';
      const suppressedNote =
        suppressed_count > 0
          ? ` (${suppressed_count} similar results suppressed)`
          : '';
      note = `${totalInBrain} relevant decisions found in team brain${historicalNote}${suppressedNote}. Use teamind_search for specific queries.`;
      firstCall = false;
    }

    return {
      decisions,
      constraints,
      patterns,
      lessons,
      historical,
      total_in_brain: totalInBrain,
      suppressed_count,
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
      suppressed_count: 0,
      offline: true,
    };
  }
}
