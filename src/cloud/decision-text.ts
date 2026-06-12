/**
 * Pure, dependency-free text helpers shared by every surface that writes
 * decision points to Qdrant (CLI `upsertDecision`, web resync seam — #293).
 *
 * Keeping these out of `qdrant/decisions.ts` matters: that module drags in
 * the embedding-strategy chain, which the web package must not bundle. This
 * module needs only `node:crypto`.
 */

import { createHash } from 'node:crypto';
import type { RawDecision } from '../types.js';

/**
 * Build a deterministic UUIDv5-shaped point ID for a chunk N>0 of a parent
 * decision. Chunk 0 always reuses the parent decision UUID so existing
 * Postgres FK references and external links keep resolving.
 *
 * The shape (8-4-4-4-12 hex) is what Qdrant accepts as a UUID-format point ID.
 * We derive it from sha256(parentId + ':' + index) and format the first 32
 * hex chars with the UUIDv5 layout (variant bits set so it's a valid UUID).
 */
export function chunkPointId(parentDecisionId: string, chunkIndex: number): string {
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
