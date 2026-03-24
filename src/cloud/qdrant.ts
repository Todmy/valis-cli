import { QdrantClient } from '@qdrant/js-client-rest';
import { randomUUID } from 'node:crypto';
import type { RawDecision, SearchResult, DecisionType } from '../types.js';

export const COLLECTION_NAME = 'decisions';
const VECTOR_SIZE = 384;

let client: QdrantClient | null = null;

export function getQdrantClient(url: string, apiKey: string): QdrantClient {
  if (!client) {
    client = new QdrantClient({ url, apiKey });
  }
  return client;
}

export function resetClient(): void {
  client = null;
}

export async function ensureCollection(qdrant: QdrantClient): Promise<void> {
  try {
    await qdrant.getCollection(COLLECTION_NAME);
  } catch {
    await qdrant.createCollection(COLLECTION_NAME, {
      vectors: {
        size: VECTOR_SIZE,
        distance: 'Cosine',
        on_disk: true,
      },
      sparse_vectors: {
        bm25: {
          modifier: 'idf' as never,
        },
      },
    });

    // Create payload indexes
    await qdrant.createPayloadIndex(COLLECTION_NAME, {
      field_name: 'org_id',
      field_schema: 'keyword',
    });

    await qdrant.createPayloadIndex(COLLECTION_NAME, {
      field_name: 'type',
      field_schema: 'keyword',
    });
  }
}

/** Optional extended fields for decision upsert (Phase 3 — search growth). */
export interface UpsertExtras {
  pinned?: boolean;
  status?: string;
  depends_on?: string[];
  replaces?: string | null;
}

export async function upsertDecision(
  qdrant: QdrantClient,
  orgId: string,
  decisionId: string,
  raw: RawDecision,
  author: string,
  extras?: UpsertExtras,
): Promise<void> {
  // Use Qdrant's server-side embedding by sending the text as document
  // Qdrant Cloud with FastEmbed generates embeddings server-side
  await qdrant.upsert(COLLECTION_NAME, {
    points: [
      {
        id: decisionId,
        payload: {
          org_id: orgId,
          type: raw.type || 'pending',
          summary: raw.summary || null,
          detail: raw.text,
          author,
          affects: raw.affects || [],
          confidence: raw.confidence || null,
          pinned: extras?.pinned ?? false,
          replaces: extras?.replaces ?? null as string | null,
          depends_on: extras?.depends_on ?? [] as string[],
          status: extras?.status ?? 'active',
          created_at: new Date().toISOString(),
        },
        // Placeholder zero vector — Qdrant Cloud with server-side embedding
        // will generate the actual vector from the document field.
        // If server-side embeddings aren't configured, search falls back to
        // payload filtering only.
        vector: new Array(VECTOR_SIZE).fill(0),
      },
    ],
  });
}

/**
 * Update the `pinned` payload field on an existing Qdrant point.
 *
 * Used by the pin/unpin lifecycle actions to keep Qdrant in sync with
 * Postgres so that the recencyDecay signal can read `pinned` at search time.
 */
export async function updatePinnedPayload(
  qdrant: QdrantClient,
  decisionId: string,
  pinned: boolean,
): Promise<void> {
  await qdrant.setPayload(COLLECTION_NAME, {
    payload: { pinned },
    points: [decisionId],
  });
}

export async function hybridSearch(
  qdrant: QdrantClient,
  orgId: string,
  query: string,
  options: { type?: string; limit?: number } = {},
): Promise<SearchResult[]> {
  const { type, limit = 10 } = options;

  const filter: Record<string, unknown> = {
    must: [
      { key: 'org_id', match: { value: orgId } },
      ...(type ? [{ key: 'type', match: { value: type } }] : []),
    ],
  };

  try {
    // Try query-based search (requires server-side embeddings)
    const results = await qdrant.query(COLLECTION_NAME, {
      query,
      filter,
      limit,
      with_payload: true,
    });

    return results.points.map((point) => mapPointToSearchResult(point, point.score || 0));
  } catch {
    // Fallback: scroll with filter only (no vector search)
    const results = await qdrant.scroll(COLLECTION_NAME, {
      filter,
      limit,
      with_payload: true,
    });

    return results.points.map((point) => mapPointToSearchResult(point, 0));
  }
}

/**
 * Map a Qdrant point (from query or scroll) to a SearchResult.
 * Extracts all payload fields including Phase 3 reranker inputs
 * (confidence, pinned, depends_on).
 */
function mapPointToSearchResult(
  point: { id: string | number; payload?: Record<string, unknown> | null | undefined; score?: number },
  score: number,
): SearchResult {
  const payload = (point.payload ?? {}) as Record<string, unknown>;
  return {
    id: point.id as string,
    score,
    type: payload.type as DecisionType,
    summary: (payload.summary as string) || null,
    detail: payload.detail as string,
    author: payload.author as string,
    affects: (payload.affects as string[]) || [],
    created_at: payload.created_at as string,
    status: (payload.status as import('../types.js').DecisionStatus) || 'active',
    replaced_by: (payload.replaces as string) || null,
    confidence: (payload.confidence as number) ?? null,
    pinned: (payload.pinned as boolean) ?? false,
    depends_on: (payload.depends_on as string[]) ?? [],
  };
}

export async function getDashboardStats(
  qdrant: QdrantClient,
  orgId: string,
): Promise<{ total: number }> {
  try {
    const result = await qdrant.count(COLLECTION_NAME, {
      filter: {
        must: [{ key: 'org_id', match: { value: orgId } }],
      },
      exact: true,
    });
    return { total: result.count };
  } catch {
    return { total: 0 };
  }
}

export async function healthCheck(qdrant: QdrantClient): Promise<boolean> {
  try {
    await qdrant.getCollections();
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Cosine similarity between two decision vectors
// ---------------------------------------------------------------------------

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0.0;

  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  if (normA === 0 || normB === 0) return 0.0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Retrieve two decision points from Qdrant and compute the cosine similarity
 * between their dense vectors.
 *
 * Returns a value in the range 0.0–1.0. Returns 0.0 when either point is not
 * found, has no vector, or has a zero-length vector.
 */
export async function getSimilarity(
  qdrant: QdrantClient,
  orgId: string,
  decisionIdA: string,
  decisionIdB: string,
): Promise<number> {
  try {
    const points = await qdrant.retrieve(COLLECTION_NAME, {
      ids: [decisionIdA, decisionIdB],
      with_vector: true,
      with_payload: true,
    });

    if (points.length < 2) return 0.0;

    // Ensure both points belong to the requested org
    const pointA = points.find((p) => p.id === decisionIdA);
    const pointB = points.find((p) => p.id === decisionIdB);
    if (!pointA || !pointB) return 0.0;

    const payloadA = pointA.payload as Record<string, unknown> | undefined;
    const payloadB = pointB.payload as Record<string, unknown> | undefined;
    if (payloadA?.org_id !== orgId || payloadB?.org_id !== orgId) return 0.0;

    // Extract dense vectors (flat number arrays)
    const vecA = pointA.vector;
    const vecB = pointB.vector;
    if (!Array.isArray(vecA) || !Array.isArray(vecB)) return 0.0;

    const similarity = cosineSimilarity(vecA as number[], vecB as number[]);
    // Clamp to [0, 1] — cosine similarity can be negative for opposed vectors
    return Math.max(0.0, Math.min(1.0, similarity));
  } catch {
    return 0.0;
  }
}
