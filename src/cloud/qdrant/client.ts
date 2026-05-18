/**
 * Qdrant client + collection lifecycle.
 *
 * Owns: lazy singleton connection, collection bootstrap (vectors + sparse +
 * payload indexes), and a liveness probe. Nothing semantic about decisions,
 * search, or admin lives here — those concerns sit in sibling modules.
 */

import { QdrantClient } from '@qdrant/js-client-rest';
import { VECTOR_SIZE, COLLECTION_NAME as EMBEDDING_COLLECTION_NAME } from '../embedding.js';

/** Re-export the active Qdrant collection name for downstream consumers. */
export const COLLECTION_NAME: string = EMBEDDING_COLLECTION_NAME;

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

    await qdrant.createPayloadIndex(COLLECTION_NAME, {
      field_name: 'project_id',
      field_schema: 'keyword',
    });
  }
}

/**
 * Ensure the `project_id` keyword payload index exists on an existing collection.
 *
 * Idempotent — Qdrant silently ignores duplicate index creation requests.
 * Called during migration or on first startup after upgrade to guarantee the
 * index is present regardless of whether ensureCollection created it.
 */
export async function ensureProjectIdIndex(qdrant: QdrantClient): Promise<void> {
  try {
    await qdrant.createPayloadIndex(COLLECTION_NAME, {
      field_name: 'project_id',
      field_schema: 'keyword',
    });
  } catch {
    // Index already exists or collection doesn't exist yet — both are fine.
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
