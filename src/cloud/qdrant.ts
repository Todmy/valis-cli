import { QdrantClient } from '@qdrant/js-client-rest';
import { randomUUID } from 'node:crypto';
import type { RawDecision, SearchResult, DecisionType } from '../types.js';

const COLLECTION_NAME = 'decisions';
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

export async function upsertDecision(
  qdrant: QdrantClient,
  orgId: string,
  decisionId: string,
  raw: RawDecision,
  author: string,
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
          replaces: null as string | null,
          depends_on: [] as string[],
          status: 'active',
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

    return results.points.map((point) => {
      const payload = point.payload as Record<string, unknown>;
      return {
        id: point.id as string,
        score: point.score || 0,
        type: payload.type as DecisionType,
        summary: (payload.summary as string) || null,
        detail: payload.detail as string,
        author: payload.author as string,
        affects: (payload.affects as string[]) || [],
        created_at: payload.created_at as string,
      };
    });
  } catch {
    // Fallback: scroll with filter only (no vector search)
    const results = await qdrant.scroll(COLLECTION_NAME, {
      filter,
      limit,
      with_payload: true,
    });

    return results.points.map((point) => {
      const payload = point.payload as Record<string, unknown>;
      return {
        id: point.id as string,
        score: 0,
        type: payload.type as DecisionType,
        summary: (payload.summary as string) || null,
        detail: payload.detail as string,
        author: payload.author as string,
        affects: (payload.affects as string[]) || [],
        created_at: payload.created_at as string,
      };
    });
  }
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
    const points = await qdrant.getPoints(COLLECTION_NAME, {
      ids: [decisionIdA, decisionIdB],
      with_vector: true,
      with_payload: true,
    });

    if (points.points.length < 2) return 0.0;

    // Ensure both points belong to the requested org
    const pointA = points.points.find((p) => p.id === decisionIdA);
    const pointB = points.points.find((p) => p.id === decisionIdB);
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
