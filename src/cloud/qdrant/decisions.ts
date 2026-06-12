/**
 * Qdrant decision CRUD — upsert (with chunking + dual-write window) and
 * payload patches that fan out across all chunks of a decision.
 *
 * Owns: decision-level operations + text helpers (`buildContextualText`,
 * `generateHypotheticalQuery`). Filter builders, search, and admin migration
 * concerns live in sibling modules.
 */

import { QdrantClient } from '@qdrant/js-client-rest';
import type { RawDecision } from '../../types.js';
import {
  detectEmbeddingStrategy,
  truncateForEmbedding,
  parseQuotaError,
  ClientEmbeddingStrategy,
} from '../embedding.js';
import { chunkText, type Chunk } from '../chunking.js';
import {
  chunkPointId,
  buildContextualText,
  generateHypotheticalQuery,
} from '../decision-text.js';
import { COLLECTION_NAME } from './client.js';

// #293: pure text helpers moved to ../decision-text.js so the web resync
// seam can import them without dragging in the embedding-strategy chain.
// Re-exported here to keep existing import sites working.
export { buildContextualText, generateHypotheticalQuery } from '../decision-text.js';

/** Optional extended fields for decision upsert (Phase 3 — search growth). */
export interface UpsertExtras {
  pinned?: boolean;
  status?: string;
  depends_on?: string[];
  replaces?: string | null;
  /** Project UUID. Included in payload for project-scoped filtering. */
  project_id?: string;
  /**
   * Origin of this decision (mcp_store, seed, file_watcher, ...).
   * Surfaced in search results so the UI can distinguish bulk-imported
   * (`seed`) decisions from organically-captured ones.
   */
  source?: string;
}

export async function upsertDecision(
  qdrant: QdrantClient,
  orgId: string,
  decisionId: string,
  raw: RawDecision,
  author: string,
  extras?: UpsertExtras,
): Promise<void> {
  // Resolve project_id from extras or raw decision
  const projectId = extras?.project_id ?? raw.project_id ?? undefined;

  // 036 (#90): match storeDecision's coercion exactly — `||` treats an empty
  // string as the default so Postgres and the Qdrant payload never diverge
  // (storeDecision used `||`, this used `??` — an empty string would persist
  // verbatim here but become 'active' in Postgres).
  const status = extras?.status || 'active';

  // Build contextual text for richer embeddings (Q4-C)
  const contextualText = buildContextualText(raw.text, raw.type, raw.affects);

  // Generate HyPE hypothetical query for better retrieval (Q4-A)
  const hypotheticalQuery = generateHypotheticalQuery(raw);

  // Use Qdrant's server-side embedding by sending the text as document
  // Qdrant Cloud with FastEmbed generates embeddings server-side
  const payload: Record<string, unknown> = {
    org_id: orgId,
    type: raw.type || 'pending',
    summary: raw.summary || null,
    detail: raw.text,
    contextual_text: contextualText,
    hypothetical_query: hypotheticalQuery,
    author,
    affects: raw.affects || [],
    confidence: raw.confidence || null,
    pinned: extras?.pinned ?? false,
    replaces: extras?.replaces ?? null as string | null,
    depends_on: extras?.depends_on ?? [] as string[],
    status,
    source: extras?.source ?? null,
    // 028-phase13/Track 5a — default outcome at write time so the rerank
    // multiplier can read it without a NULL guard. Updated later via
    // `valis_update_outcome` which also syncs Qdrant payload.
    outcome: 'unknown',
    created_at: new Date().toISOString(),
  };

  // Include project_id when available (omitted for legacy compat)
  if (projectId) {
    payload.project_id = projectId;
  }

  // 019/US4 — chunk long decisions for the e5-large 514-token window.
  // Each chunk becomes a separate Qdrant point sharing the same parent
  // payload + carrying chunk-specific metadata (decision_id, chunk_index,
  // total_chunks, chunk_text). Search-side dedup groups by decision_id and
  // keeps the max score per parent decision.
  const strategy = await detectEmbeddingStrategy(qdrant, COLLECTION_NAME);
  const chunks: Chunk[] = chunkText(contextualText);

  const buildPointForChunk = async (chunk: Chunk) => {
    const chunkPayload: Record<string, unknown> = {
      ...payload,
      decision_id: decisionId,
      chunk_index: chunk.index,
      total_chunks: chunk.total,
      chunk_text: chunk.text,
    };
    const embedInput = truncateForEmbedding(chunk.text);
    const vector =
      strategy.mode === 'server'
        ? strategy.vectorForUpsert(embedInput)
        : await (strategy as ClientEmbeddingStrategy).vectorForUpsertAsync(embedInput);
    return {
      id: chunkPointId(decisionId, chunk.index),
      payload: chunkPayload,
      vector: vector as never,
    };
  };

  try {
    const points = await Promise.all(chunks.map(buildPointForChunk));
    await qdrant.upsert(COLLECTION_NAME, { points });

    // #293: chunk point IDs are deterministic, so re-upserting a shrunken
    // body overwrites chunks 0..N-1 but leaves old chunks N..M orphaned —
    // stale text that keeps matching searches. Delete the tail by filter.
    // Best-effort: cleanup failure must not fail the store (Constitution III
    // Non-Blocking); the next re-upsert retries the same idempotent delete.
    try {
      await qdrant.delete(COLLECTION_NAME, {
        filter: {
          must: [
            { key: 'decision_id', match: { value: decisionId } },
            { key: 'chunk_index', range: { gte: chunks.length } },
          ],
        },
      } as never);
    } catch {
      // Ignored — orphans stay until the next successful resync.
    }
  } catch (err) {
    const quota = parseQuotaError(err, strategy.mode);
    if (quota) {
      // Re-throw as a structured error. The capture / store flow catches this
      // and routes the decision into the offline queue (~/.valis/pending.jsonl)
      // per FR-023a / Constitution III (Non-Blocking).
      throw quota;
    }
    throw err;
  }
}

/**
 * 019/US4 helper: apply a payload patch to all chunks of a decision (or
 * the legacy single point if the record predates chunking). Keeps multi-chunk
 * payload coherent for downstream readers.
 */
export async function setDecisionPayload(
  qdrant: QdrantClient,
  decisionId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await qdrant.setPayload(COLLECTION_NAME, {
    payload,
    filter: {
      should: [
        { must: [{ key: 'decision_id', match: { value: decisionId } }] },
        { has_id: [decisionId] },
      ],
    },
  } as never);
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
  // 019/US4: a decision may live as N chunk points sharing decision_id.
  // Update by filter so all chunks stay in sync. Filter also matches the
  // legacy single-point case where the point id == decision id (no
  // decision_id payload field) — should clause covers both shapes.
  await qdrant.setPayload(COLLECTION_NAME, {
    payload: { pinned },
    filter: {
      should: [
        { must: [{ key: 'decision_id', match: { value: decisionId } }] },
        { has_id: [decisionId] },
      ],
    },
  } as never);
}
