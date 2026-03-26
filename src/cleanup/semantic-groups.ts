/**
 * Semantic grouping — extends near-duplicate detection into cluster-level
 * analysis with suggested actions (merge / review / keep).
 *
 * Algorithm:
 * 1. Use findNearDuplicates() from dedup.ts with a lower threshold (0.7)
 * 2. Build groups from connected near-duplicates via union-find
 * 3. Pick a representative per group (highest confidence + most recent)
 * 4. Suggest action based on average similarity within the group
 * 5. For 'merge' groups: generate a merged summary via template
 *
 * @module cleanup/semantic-groups
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { QdrantClient } from '@qdrant/js-client-rest';
import type { Decision } from '../types.js';
import { findNearDuplicates, type DedupCandidate } from './dedup.js';
import { generateGroupSummary } from '../synthesis/summarize.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SemanticGroup {
  /** Most important/recent decision in the group. */
  representative: Decision;
  /** All decisions in the group (including representative). */
  members: Decision[];
  /** Average pairwise similarity within the group. */
  similarity: number;
  /** Suggested consolidation action. */
  suggestedAction: 'merge' | 'keep' | 'review';
  /** Auto-generated summary if merged. */
  mergedSummary?: string;
}

export interface SemanticGroupOptions {
  /** Cosine similarity threshold for grouping (default 0.7). */
  threshold?: number;
  /** Minimum members to form a group (default 2). */
  minGroupSize?: number;
}

// ---------------------------------------------------------------------------
// Union-Find
// ---------------------------------------------------------------------------

class UnionFind {
  private parent: Map<string, string> = new Map();

  find(x: string): string {
    if (!this.parent.has(x)) this.parent.set(x, x);
    if (this.parent.get(x) !== x) {
      this.parent.set(x, this.find(this.parent.get(x)!));
    }
    return this.parent.get(x)!;
  }

  unite(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }

  groups(): Map<string, string[]> {
    const result = new Map<string, string[]>();
    for (const key of this.parent.keys()) {
      const root = this.find(key);
      const arr = result.get(root) ?? [];
      arr.push(key);
      result.set(root, arr);
    }
    return result;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Pick the representative decision from a group.
 * Prefers highest confidence, then most recent created_at as tiebreaker.
 */
export function pickRepresentative(members: Decision[]): Decision {
  return members.reduce((best, d) => {
    const bestConf = best.confidence ?? 0;
    const dConf = d.confidence ?? 0;
    if (dConf > bestConf) return d;
    if (dConf === bestConf) {
      return new Date(d.created_at) > new Date(best.created_at) ? d : best;
    }
    return best;
  });
}

/**
 * Determine suggested action based on average similarity.
 */
export function suggestAction(similarity: number): 'merge' | 'review' | 'keep' {
  if (similarity > 0.9) return 'merge';
  if (similarity >= 0.8) return 'review';
  return 'keep';
}

/**
 * Compute the average similarity for a group from the pairwise scores
 * recorded in the dedup candidates.
 */
function averageSimilarity(
  memberIds: Set<string>,
  pairScores: Map<string, number>,
): number {
  let sum = 0;
  let count = 0;
  for (const [key, score] of pairScores) {
    const [a, b] = key.split('|');
    if (memberIds.has(a) && memberIds.has(b)) {
      sum += score;
      count++;
    }
  }
  return count > 0 ? sum / count : 0;
}

// ---------------------------------------------------------------------------
// Main: findSemanticGroups
// ---------------------------------------------------------------------------

/**
 * Find semantic groups of related decisions using vector similarity.
 *
 * Fetches all active decisions for the org, runs near-duplicate detection
 * at a lower threshold, then builds connected-component groups using
 * union-find.
 */
export async function findSemanticGroups(
  qdrant: QdrantClient,
  supabase: SupabaseClient,
  orgId: string,
  options: SemanticGroupOptions = {},
): Promise<SemanticGroup[]> {
  const threshold = options.threshold ?? 0.7;
  const minGroupSize = options.minGroupSize ?? 2;

  // 1. Fetch active decisions
  const { data, error } = await supabase
    .from('decisions')
    .select('*')
    .eq('org_id', orgId)
    .eq('status', 'active')
    .order('created_at', { ascending: false });

  if (error) throw new Error(`Failed to fetch decisions: ${error.message}`);
  const decisions = (data ?? []) as Decision[];
  if (decisions.length === 0) return [];

  // Build a lookup map
  const decisionMap = new Map<string, Decision>();
  for (const d of decisions) decisionMap.set(d.id, d);

  // 2. Find near-duplicates at the given threshold
  const candidates = await findNearDuplicates(qdrant, orgId, decisions, threshold);

  if (candidates.length === 0) return [];

  // 3. Build union-find groups from connected pairs + track pairwise scores
  const uf = new UnionFind();
  const pairScores = new Map<string, number>();

  for (const c of candidates) {
    for (const depId of c.deprecateIds) {
      uf.unite(c.keepId, depId);
      const key = [c.keepId, depId].sort().join('|');
      // Keep max score if we see the same pair from both directions
      const existing = pairScores.get(key) ?? 0;
      if (c.similarity > existing) {
        pairScores.set(key, c.similarity);
      }
    }
  }

  // 4. Collect groups and build SemanticGroup objects
  const rawGroups = uf.groups();
  const result: SemanticGroup[] = [];

  for (const [, memberIds] of rawGroups) {
    if (memberIds.length < minGroupSize) continue;

    const members = memberIds
      .map((id) => decisionMap.get(id))
      .filter((d): d is Decision => d !== undefined);

    if (members.length < minGroupSize) continue;

    const memberIdSet = new Set(memberIds);
    const sim = averageSimilarity(memberIdSet, pairScores);
    const representative = pickRepresentative(members);
    const action = suggestAction(sim);

    const group: SemanticGroup = {
      representative,
      members,
      similarity: sim,
      suggestedAction: action,
    };

    // Generate merged summary for 'merge' groups
    if (action === 'merge') {
      group.mergedSummary = generateGroupSummary(members);
    }

    result.push(group);
  }

  // Sort by similarity descending
  result.sort((a, b) => b.similarity - a.similarity);

  return result;
}
