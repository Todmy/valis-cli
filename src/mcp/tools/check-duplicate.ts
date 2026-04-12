import { loadConfig } from '../../config/store.js';
import { resolveConfig } from '../../config/project.js';
import { getQdrantClient, buildProjectFilter, COLLECTION_NAME } from '../../cloud/qdrant.js';
import {
  detectEmbeddingStrategy,
  truncateForEmbedding,
  ClientEmbeddingStrategy,
  DENSE_VECTOR_NAME,
} from '../../cloud/embedding.js';
import type { ServerConfig, ValisConfig, DecisionStatus } from '../../types.js';

interface CheckDuplicateArgs {
  text: string;
  threshold?: number;
}

interface DuplicateMatch {
  id: string;
  summary: string | null;
  similarity: number;
  status: DecisionStatus;
  created_at: string | null;
}

interface CheckDuplicateResponse {
  duplicates: DuplicateMatch[];
  checked_count: number;
  error?: string;
}

const DEFAULT_THRESHOLD = 0.85;

export async function handleCheckDuplicate(
  args: CheckDuplicateArgs,
  configOverride?: ServerConfig,
): Promise<CheckDuplicateResponse> {
  try {
    const config = (configOverride ?? await loadConfig()) as ValisConfig | null;
    if (!config) {
      return { duplicates: [], checked_count: 0, error: 'not_configured' };
    }

    // Resolve project
    const resolved = configOverride ? null : await resolveConfig();
    const projectId = configOverride?.project_id || resolved?.project?.project_id;

    // In hosted mode without direct Qdrant access, return gracefully
    if (!config.qdrant_url || !config.qdrant_api_key) {
      return { duplicates: [], checked_count: 0, error: 'search_unavailable' };
    }

    const qdrant = getQdrantClient(config.qdrant_url, config.qdrant_api_key);
    const strategy = await detectEmbeddingStrategy(qdrant, COLLECTION_NAME);
    const threshold = args.threshold ?? DEFAULT_THRESHOLD;

    // Embed the input text
    const truncated = truncateForEmbedding(args.text);
    let denseQuery: unknown;

    if (strategy.mode === 'client') {
      denseQuery = await (strategy as ClientEmbeddingStrategy).queryForDenseAsync(truncated);
    } else {
      denseQuery = strategy.queryForDense(truncated);
    }

    // Build filter scoped to org + project
    const filter = buildProjectFilter(config.org_id, projectId ?? undefined);

    // Query Qdrant for top-3 matches above threshold
    const results = await qdrant.query(COLLECTION_NAME, {
      query: denseQuery as never,
      using: DENSE_VECTOR_NAME,
      filter,
      limit: 3,
      score_threshold: threshold,
      with_payload: true,
    });

    const duplicates: DuplicateMatch[] = results.points
      .map((point) => {
        const payload = (point.payload ?? {}) as Record<string, unknown>;
        return {
          id: point.id as string,
          summary: (payload.summary as string) || null,
          similarity: point.score ?? 0,
          status: ((payload.status as DecisionStatus) || 'active'),
          created_at: (payload.created_at as string) || null,
        };
      })
      .sort((a, b) => b.similarity - a.similarity);

    return {
      duplicates,
      checked_count: results.points.length,
    };
  } catch {
    // NEVER throws — returns empty on any failure
    return { duplicates: [], checked_count: 0, error: 'search_unavailable' };
  }
}
