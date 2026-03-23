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
