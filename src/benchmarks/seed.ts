/**
 * 021/T011: ephemeral Qdrant collection seeding.
 *
 * Creates a benchmark-scoped collection (`valis_bench_<runId>`) matching the
 * production schema (384d dense + BM25 sparse, idf modifier), embeds the
 * corpus documents using the same `cloud/chunking.ts` primitives as prod,
 * and returns a handle whose `.drop()` is idempotent.
 *
 * Credential isolation (spec §"BENCHMARK_QDRANT_*"):
 *   Reads `BENCHMARK_QDRANT_URL` + `BENCHMARK_QDRANT_API_KEY` from env.
 *   Fails loudly if either is unset. Never falls back to the production
 *   `QDRANT_URL` / `QDRANT_API_KEY` — keeps benchmark traffic + ephemeral
 *   collections strictly out of the production cluster scope.
 *
 * Cleanup safety net: a single `SIGINT` / `SIGTERM` listener walks the
 * collections-still-alive set and drops them best-effort before the
 * process exits, so an Ctrl-C mid-run doesn't leak collections.
 */

import { QdrantClient } from '@qdrant/js-client-rest';
import { chunkText } from '../cloud/chunking.js';
import {
  DENSE_MODEL,
  VECTOR_SIZE,
  BM25_MODEL,
  DENSE_VECTOR_NAME,
  BM25_VECTOR_NAME,
} from '../cloud/embedding.js';
import type { CorpusSlice } from './types.js';

export interface EphemeralCollection {
  name: string;
  drop: () => Promise<void>;
}

interface BenchmarkQdrantEnv {
  url: string;
  apiKey: string;
}

function readBenchmarkEnv(): BenchmarkQdrantEnv {
  const url = process.env.BENCHMARK_QDRANT_URL;
  const apiKey = process.env.BENCHMARK_QDRANT_API_KEY;
  if (!url || !apiKey) {
    throw new Error(
      'BENCHMARK_QDRANT_URL and BENCHMARK_QDRANT_API_KEY must both be set. ' +
        'These are required to be distinct from prod creds per ' +
        'specs/021-public-benchmarks/spec.md §isolation.',
    );
  }
  return { url, apiKey };
}

let _client: QdrantClient | null = null;
function getBenchmarkClient(): QdrantClient {
  if (_client) return _client;
  const { url, apiKey } = readBenchmarkEnv();
  _client = new QdrantClient({ url, apiKey });
  return _client;
}

const ALIVE = new Set<string>();
let SIGNAL_HOOK_INSTALLED = false;
function installSignalHook(): void {
  if (SIGNAL_HOOK_INSTALLED) return;
  SIGNAL_HOOK_INSTALLED = true;
  const cleanup = async (): Promise<void> => {
    const client = _client;
    if (!client || ALIVE.size === 0) return;
    for (const name of [...ALIVE]) {
      try {
        await client.deleteCollection(name);
      } catch {
        // best-effort
      }
    }
    ALIVE.clear();
  };
  process.once('SIGINT', () => {
    void cleanup().finally(() => process.exit(130));
  });
  process.once('SIGTERM', () => {
    void cleanup().finally(() => process.exit(143));
  });
}

/**
 * Create the ephemeral collection, embed + upsert the corpus's documents,
 * and return a drop handle.
 *
 * Schema mirrors `packages/cli/src/cloud/qdrant/client.ts#ensureCollection`:
 * a single dense vector (Cosine, on-disk) + BM25 sparse vector with the
 * `idf` modifier. Payload carries `doc_id` (the corpus document id) so the
 * searchFn adapter can dedup chunks back to a single hit per document.
 */
export async function seedEphemeralCollection(
  corpus: CorpusSlice,
  runId: string,
): Promise<EphemeralCollection> {
  installSignalHook();
  const qdrant = getBenchmarkClient();
  const collectionName = `valis_bench_${runId}`;

  const denseModel = DENSE_MODEL;
  const vectorSize = VECTOR_SIZE;

  await qdrant.createCollection(collectionName, {
    vectors: {
      size: vectorSize,
      distance: 'Cosine',
      on_disk: true,
    },
    sparse_vectors: {
      [BM25_VECTOR_NAME]: {
        modifier: 'idf' as never,
      },
    },
  });
  ALIVE.add(collectionName);

  await qdrant.createPayloadIndex(collectionName, {
    field_name: 'doc_id',
    field_schema: 'keyword',
  });

  const points: Array<{ id: string; vector: unknown; payload: Record<string, unknown> }> = [];
  for (const doc of corpus.documents) {
    const chunks = chunkText(doc.text);
    for (const chunk of chunks) {
      points.push({
        id: cryptoUUIDv4(),
        vector: {
          [DENSE_VECTOR_NAME]: { text: chunk.text, model: denseModel },
          [BM25_VECTOR_NAME]: { text: chunk.text, model: BM25_MODEL },
        },
        payload: {
          doc_id: doc.id,
          chunk_index: chunk.index,
          total_chunks: chunk.total,
          chunk_text: chunk.text,
          language: doc.language ?? 'mixed',
        },
      });
    }
  }

  const UPSERT_BATCH = 64;
  for (let i = 0; i < points.length; i += UPSERT_BATCH) {
    await qdrant.upsert(collectionName, {
      points: points.slice(i, i + UPSERT_BATCH) as never,
    });
  }

  let dropped = false;
  const drop = async (): Promise<void> => {
    if (dropped) return;
    dropped = true;
    ALIVE.delete(collectionName);
    try {
      await qdrant.deleteCollection(collectionName);
    } catch {
      // already deleted / collection gone — fine
    }
  };

  return { name: collectionName, drop };
}

function cryptoUUIDv4(): string {
  // Avoid bringing `crypto.randomUUID` only — pin to a v4 string the Qdrant
  // client accepts. Node ≥ 20 ships randomUUID on the global crypto object.
  return globalThis.crypto.randomUUID();
}
