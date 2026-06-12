/**
 * Qdrant decision CRUD — upsert (with chunking + dual-write window) and
 * payload patches that fan out across all chunks of a decision.
 *
 * Owns: decision-level operations + text helpers (`buildContextualText`,
 * `generateHypotheticalQuery`). Filter builders, search, and admin migration
 * concerns live in sibling modules.
 */

import { QdrantClient } from '@qdrant/js-client-rest';
import { createHash } from 'node:crypto';
import type { RawDecision } from '../../types.js';
import {
  detectEmbeddingStrategy,
  truncateForEmbedding,
  parseQuotaError,
  ClientEmbeddingStrategy,
} from '../embedding.js';
import { chunkText, type Chunk } from '../chunking.js';
import { COLLECTION_NAME } from './client.js';

/**
 * Build a deterministic UUIDv5-shaped point ID for a chunk N>0 of a parent
 * decision. Chunk 0 always reuses the parent decision UUID so existing
 * Postgres FK references and external links keep resolving.
 *
 * The shape (8-4-4-4-12 hex) is what Qdrant accepts as a UUID-format point ID.
 * We derive it from sha256(parentId + ':' + index) and format the first 32
 * hex chars with the UUIDv5 layout (variant bits set so it's a valid UUID).
 */
function chunkPointId(parentDecisionId: string, chunkIndex: number): string {
  if (chunkIndex === 0) return parentDecisionId;
  const h = createHash('sha256')
    .update(`${parentDecisionId}:chunk:${chunkIndex}`)
    .digest('hex');
  // RFC 4122 v5-shaped: set version=5 in high nibble of byte 6, variant=10
  // in high bits of byte 8.
  const b6 = ((parseInt(h.slice(12, 14), 16) & 0x0f) | 0x50)
    .toString(16)
    .padStart(2, '0');
  const b8 = ((parseInt(h.slice(16, 18), 16) & 0x3f) | 0x80)
    .toString(16)
    .padStart(2, '0');
  return [
    h.slice(0, 8),
    h.slice(8, 12),
    `${b6}${h.slice(14, 16)}`,
    `${b8}${h.slice(18, 20)}`,
    h.slice(20, 32),
  ].join('-');
}

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

/**
 * Build a contextual text string that prepends type and affects metadata
 * to the raw decision text (Q4-C). This gives the embedding model richer
 * context about the decision's domain, improving vector search recall.
 *
 * Format: `[{type}] [{affects joined}] {text}`
 * Example: `[decision] [authentication, security] Use JWT with RS256 for API auth`
 */
export function buildContextualText(
  text: string,
  type: string | undefined,
  affects: string[] | undefined,
): string {
  const typePart = `[${type || 'pending'}]`;
  const affectsPart = affects && affects.length > 0 ? ` [${affects.join(', ')}]` : '';
  return `${typePart}${affectsPart} ${text}`;
}

/**
 * Generate a hypothetical question that a decision answers (HyPE — Hypothetical
 * Passage Embedding, from Q4-A). Stored in payload for better retrieval at
 * search time.
 *
 * Uses template-based generation (no LLM required):
 * - If `affects` areas exist: "What is the team's decision about {affects}?"
 * - If summary exists: "What did the team decide regarding {summary}?"
 * - Fallback: uses the first 80 chars of the decision text.
 */
export function generateHypotheticalQuery(raw: RawDecision): string {
  const affects = raw.affects ?? [];

  if (affects.length > 0) {
    return `What is the team's decision about ${affects.join(', ')}?`;
  }

  if (raw.summary) {
    return `What did the team decide regarding ${raw.summary}?`;
  }

  // Fallback: use truncated text
  const truncated = raw.text.slice(0, 80).replace(/\s+/g, ' ').trim();
  return `What did the team decide regarding ${truncated}?`;
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
