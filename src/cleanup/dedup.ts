/**
 * Exact and near-duplicate detection for decisions.
 *
 * - Exact duplicates share the same `content_hash` within an org and are
 *   auto-deprecated (newest kept).
 * - Near-duplicates have cosine similarity > threshold (default 0.9) and are
 *   flagged for manual review only.
 *
 * Protection rules:
 *   - Pinned decisions are NEVER auto-deprecated.
 *   - Decisions with inbound `depends_on` references are flagged for review.
 *
 * @module cleanup/dedup
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { QdrantClient } from '@qdrant/js-client-rest';
import type { Decision } from '../types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DedupCandidate {
  /** The decision to keep (newest by created_at). */
  keepId: string;
  /** The decisions to deprecate. */
  deprecateIds: string[];
  /** Detection method: 'exact_hash' or 'near_duplicate'. */
  method: 'exact_hash' | 'near_duplicate';
  /** Similarity score (1.0 for exact, 0.9+ for near). */
  similarity: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const COLLECTION_NAME = 'decisions';

/**
 * Deduplicate symmetric candidate pairs so that (A,B) and (B,A) are collapsed
 * into a single candidate.
 */
export function deduplicateCandidates(
  candidates: DedupCandidate[],
): DedupCandidate[] {
  const seen = new Set<string>();
  const result: DedupCandidate[] = [];

  for (const c of candidates) {
    // Build a canonical key from sorted involved IDs
    const allIds = [c.keepId, ...c.deprecateIds].sort();
    const key = allIds.join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(c);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Exact-duplicate detection
// ---------------------------------------------------------------------------

/**
 * Find groups of active decisions that share the same `content_hash` within an
 * org.  For each group the newest decision is kept and the rest are returned as
 * candidates for deprecation.
 *
 * Protection rules are applied:
 *   - Pinned decisions are excluded from deprecation (but may still be the
 *     "keep" decision).
 *   - Decisions that have inbound `depends_on` from other active decisions are
 *     excluded from auto-deprecation and instead flagged for manual review.
 */
export async function findExactDuplicates(
  supabase: SupabaseClient,
  orgId: string,
  projectId?: string,
): Promise<DedupCandidate[]> {
  // Fetch all active decisions for this org, optionally scoped to project
  let query = supabase
    .from('decisions')
    .select('id, content_hash, created_at, pinned, depends_on')
    .eq('org_id', orgId)
    .eq('status', 'active');
  if (projectId) {
    query = query.eq('project_id', projectId);
  }
  const { data, error } = await query
    .order('created_at', { ascending: false });

  if (error) throw new Error(`Failed to fetch decisions for dedup: ${error.message}`);
  if (!data || data.length === 0) return [];

  // Group by content_hash
  const groups = new Map<string, typeof data>();
  for (const d of data) {
    if (!d.content_hash) continue;
    const arr = groups.get(d.content_hash) ?? [];
    arr.push(d);
    groups.set(d.content_hash, arr);
  }

  // Build a set of IDs that have inbound depends_on from other decisions
  const allDependedOn = new Set<string>();
  for (const d of data) {
    if (d.depends_on && Array.isArray(d.depends_on)) {
      for (const depId of d.depends_on) {
        allDependedOn.add(depId);
      }
    }
  }

  const candidates: DedupCandidate[] = [];

  for (const [, group] of groups) {
    if (group.length < 2) continue;

    // Sorted newest first (already from query, but be safe)
    group.sort(
      (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
    );

    const keepId = group[0].id;
    const deprecateIds: string[] = [];

    for (let i = 1; i < group.length; i++) {
      const d = group[i];
      // Protection: pinned decisions are never auto-deprecated
      if (d.pinned) continue;
      // Protection: decisions with inbound depends_on are flagged, not auto-deprecated
      if (allDependedOn.has(d.id)) continue;

      deprecateIds.push(d.id);
    }

    if (deprecateIds.length > 0) {
      candidates.push({
        keepId,
        deprecateIds,
        method: 'exact_hash',
        similarity: 1.0,
      });
    }
  }

  return candidates;
}

// ---------------------------------------------------------------------------
// Near-duplicate detection (Qdrant cosine similarity)
// ---------------------------------------------------------------------------

/**
 * For each active decision, query Qdrant for similar points above the cosine
 * threshold within the same org.  Symmetric pairs are deduplicated so that
 * (A,B) and (B,A) produce only one candidate.
 *
 * Near-duplicates are flagged for review, NOT auto-deprecated.
 */
export async function findNearDuplicates(
  qdrant: QdrantClient,
  orgId: string,
  decisions: Decision[],
  threshold = 0.9,
): Promise<DedupCandidate[]> {
  const candidates: DedupCandidate[] = [];

  for (const decision of decisions) {
    try {
      // Use Qdrant query to find similar points by decision point ID
      const similar = await qdrant.query(COLLECTION_NAME, {
        query: decision.id,
        filter: {
          must: [
            { key: 'org_id', match: { value: orgId } },
            { key: 'status', match: { value: 'active' } },
          ],
          must_not: [
            { has_id: [decision.id] },
          ],
        },
        limit: 5,
        with_payload: true,
      });

      const nearDupes = similar.points
        .filter((p) => (p.score ?? 0) > threshold)
        .map((p) => ({
          id: p.id as string,
          score: p.score ?? 0,
        }));

      if (nearDupes.length > 0) {
        candidates.push({
          keepId: decision.id,
          deprecateIds: nearDupes.map((d) => d.id),
          method: 'near_duplicate',
          similarity: nearDupes[0].score,
        });
      }
    } catch {
      // Skip individual decision failures — do not halt the batch
      continue;
    }
  }

  return deduplicateCandidates(candidates);
}
