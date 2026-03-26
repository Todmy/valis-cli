/**
 * Individual signal computation functions for the multi-signal reranker.
 *
 * Each function produces a value in [0, 1] suitable for weighted combination.
 *
 * Signals from three approaches merged:
 * - Q4-A: contentAwareRecencyDecay (per-type half-lives)
 * - Q4-B: tokenOverlapScore, negationAwarenessScore, freshnessBoost
 * - Q4-C: areaCooccurrence (implicit graph from affects overlap)
 *
 * @module search/signals
 */

import type { DecisionType } from '../types.js';

// ---------------------------------------------------------------------------
// 1. Recency Decay
// ---------------------------------------------------------------------------

const MS_PER_DAY = 86_400_000;

/**
 * Content-type-aware half-life values (in days).
 *
 * Different decision types age at different rates:
 * - `decision`: architectural choices stay relevant longer (6 months)
 * - `constraint`: constraints rarely change (12 months)
 * - `pattern`: medium relevance window (3 months)
 * - `lesson`: bug fixes become irrelevant quickly (1 month)
 * - `pending`: unclassified, use default (3 months)
 */
export const CONTENT_HALF_LIFE_DAYS: Record<DecisionType, number> = {
  decision: 180,   // 6 months — architectural choices stay relevant
  constraint: 365, // 12 months — constraints rarely change
  pattern: 90,     // 3 months — medium decay
  lesson: 30,      // 1 month — bug fixes become irrelevant quickly
  pending: 90,     // 3 months — default for unclassified
};

/**
 * Exponential recency decay.
 *
 * Formula: `score = 0.5 ^ (ageDays / halfLifeDays)`
 *
 * | Age (days) | Score (half-life=90) |
 * |-----------|----------------------|
 * | 0         | 1.000                |
 * | 30        | 0.794                |
 * | 90        | 0.500                |
 * | 180       | 0.250                |
 * | 365       | 0.062                |
 *
 * Pinned decisions are exempt from decay and always return 1.0.
 *
 * @param createdAt  ISO-8601 timestamp of the decision.
 * @param halfLifeDays  Number of days until the score halves (default 90).
 * @param pinned  If true, bypass decay and return 1.0.
 * @param now  Current time in ms (injectable for testing).
 * @returns A value in [0, 1].
 */
export function recencyDecay(
  createdAt: string,
  halfLifeDays: number = 90,
  pinned: boolean = false,
  now: number = Date.now(),
): number {
  if (pinned) return 1.0;
  if (halfLifeDays <= 0) return 1.0;

  const ageDays = (now - new Date(createdAt).getTime()) / MS_PER_DAY;
  if (ageDays <= 0) return 1.0;

  return Math.pow(0.5, ageDays / halfLifeDays);
}

/**
 * Content-type-aware recency decay (from Q4-A).
 *
 * Uses per-type half-life curves so that architectural decisions decay slowly
 * while lessons (bug fixes) decay fast. The `baseHalfLifeDays` parameter
 * acts as a scaling factor: if the caller configured a custom half-life,
 * each type's half-life is proportionally adjusted.
 *
 * @param createdAt      ISO-8601 timestamp of the decision.
 * @param type           Decision type (decision/constraint/pattern/lesson/pending).
 * @param baseHalfLifeDays  Org-configured base half-life (default 90, used for scaling).
 * @param pinned         If true, bypass decay and return 1.0.
 * @param now            Current time in ms (injectable for testing).
 * @returns A value in [0, 1].
 */
export function contentAwareRecencyDecay(
  createdAt: string,
  type: DecisionType | undefined,
  baseHalfLifeDays: number = 90,
  pinned: boolean = false,
  now: number = Date.now(),
): number {
  if (pinned) return 1.0;

  const resolvedType = type ?? 'pending';
  const typeHalfLife = CONTENT_HALF_LIFE_DAYS[resolvedType] ?? 90;

  // Scale the type-specific half-life by the org's configured base.
  // Default base is 90 (pattern's half-life), so ratio = 1.0 at default.
  const scaleFactor = baseHalfLifeDays / 90;
  const adjustedHalfLife = typeHalfLife * scaleFactor;

  return recencyDecay(createdAt, adjustedHalfLife, false, now);
}

// ---------------------------------------------------------------------------
// 2. Importance Score
// ---------------------------------------------------------------------------

/**
 * Importance signal combining confidence and pin status.
 *
 * Formula: `score = min(1.0, (confidence ?? 0.5) * (pinned ? 2.0 : 1.0))`
 *
 * A pinned decision with confidence 0.8 gets importance 1.0 (clamped).
 * An unpinned decision with confidence 0.5 gets importance 0.5.
 * A null-confidence decision defaults to 0.5 baseline.
 *
 * @param confidence  Decision confidence (0-1), nullable.
 * @param pinned  Whether the decision is pinned.
 * @returns A value in [0, 1].
 */
export function importanceScore(
  confidence: number | null | undefined,
  pinned: boolean = false,
): number {
  const base = confidence ?? 0.5;
  const boosted = pinned ? base * 2.0 : base;
  return Math.min(1.0, Math.max(0.0, boosted));
}

// ---------------------------------------------------------------------------
// 3. Graph Connectivity (enhanced with area co-occurrence from Q4-C)
// ---------------------------------------------------------------------------

/**
 * Graph connectivity signal combining inbound dependency count and
 * area co-occurrence density (Q4-C enhancement).
 *
 * Two sub-signals (equally weighted, then normalized):
 *
 * 1. **Inbound deps**: how many other results depend on this decision
 *    (via `depends_on`). Normalized with log1p compression.
 *
 * 2. **Area density**: decisions sharing `affects` tags form implicit clusters.
 *    For each result, count how many other results share at least one `affects`
 *    tag. Decisions in dense clusters (well-documented areas) get a boost.
 *    Normalized with log1p compression.
 *
 * Final score = 0.5 * inbound_normalized + 0.5 * area_normalized
 *
 * @param decisionId  The decision ID to compute connectivity for.
 * @param allResults  The full set of results to count inbound references within.
 * @returns A value in [0, 1].
 */
export function graphConnectivity(
  decisionId: string,
  allResults: Array<{ id: string; depends_on?: string[]; affects?: string[] }>,
): number {
  // --- Sub-signal 1: Inbound dependency count --------------------------------
  let maxInbound = 0;
  const inboundCounts = new Map<string, number>();
  for (const r of allResults) {
    inboundCounts.set(r.id, 0);
  }

  for (const r of allResults) {
    if (!r.depends_on) continue;
    for (const depId of r.depends_on) {
      const current = inboundCounts.get(depId);
      if (current !== undefined) {
        inboundCounts.set(depId, current + 1);
      }
    }
  }

  for (const count of inboundCounts.values()) {
    if (count > maxInbound) maxInbound = count;
  }

  const inbound = inboundCounts.get(decisionId) ?? 0;
  const inboundNorm = maxInbound > 0 ? Math.log1p(inbound) / Math.log1p(maxInbound) : 0;

  // --- Sub-signal 2: Area co-occurrence density (Q4-C) -----------------------
  const areaDensity = areaCooccurrence(decisionId, allResults);

  // --- Combine: equal weight when both signals are active --------------------
  if (maxInbound === 0 && areaDensity === 0) return 0;
  if (maxInbound === 0) return areaDensity;
  if (areaDensity === 0) return inboundNorm;

  return 0.5 * inboundNorm + 0.5 * areaDensity;
}

/**
 * Area co-occurrence density for a single decision within the result set (Q4-C).
 *
 * Builds an in-memory adjacency map from `affects` arrays: two decisions
 * are neighbors if they share at least one `affects` tag. Returns a
 * log1p-normalized score of how many neighbors the target decision has.
 *
 * @param decisionId  Target decision.
 * @param allResults  Full result set with `affects` arrays.
 * @returns A value in [0, 1]. 0 when no co-occurrence exists.
 */
export function areaCooccurrence(
  decisionId: string,
  allResults: Array<{ id: string; affects?: string[] }>,
): number {
  // Build area -> set of decision IDs index
  const areaIndex = new Map<string, Set<string>>();
  for (const r of allResults) {
    if (!r.affects) continue;
    for (const area of r.affects) {
      let set = areaIndex.get(area);
      if (!set) {
        set = new Set();
        areaIndex.set(area, set);
      }
      set.add(r.id);
    }
  }

  // Count co-occurrence neighbors for each decision
  const neighborCounts = new Map<string, number>();
  for (const r of allResults) {
    const neighbors = new Set<string>();
    if (r.affects) {
      for (const area of r.affects) {
        const peers = areaIndex.get(area);
        if (peers) {
          for (const peerId of peers) {
            if (peerId !== r.id) neighbors.add(peerId);
          }
        }
      }
    }
    neighborCounts.set(r.id, neighbors.size);
  }

  // Normalize with log1p
  let maxNeighbors = 0;
  for (const count of neighborCounts.values()) {
    if (count > maxNeighbors) maxNeighbors = count;
  }

  const myNeighbors = neighborCounts.get(decisionId) ?? 0;
  if (maxNeighbors === 0) return 0;
  return Math.log1p(myNeighbors) / Math.log1p(maxNeighbors);
}

// ---------------------------------------------------------------------------
// 4. BM25 Normalization
// ---------------------------------------------------------------------------

/**
 * Min-max normalize an array of raw BM25 scores to [0, 1].
 *
 * - If all scores are equal, normalizes every value to 0.5.
 * - If the array is empty, returns an empty array.
 *
 * @param scores  Raw BM25 scores (unbounded positive values).
 * @returns Normalized scores in [0, 1], same length and order as input.
 */
export function normalizeBm25(scores: number[]): number[] {
  if (scores.length === 0) return [];

  let min = Infinity;
  let max = -Infinity;
  for (const s of scores) {
    if (s < min) min = s;
    if (s > max) max = s;
  }

  const range = max - min;
  if (range === 0) {
    return scores.map(() => 0.5);
  }

  return scores.map((s) => (s - min) / range);
}

// ---------------------------------------------------------------------------
// 5. Token Overlap Score (from Q4-B)
// ---------------------------------------------------------------------------

/** Common English stopwords excluded from token overlap comparison. */
const TOKEN_STOPWORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'shall', 'can', 'need', 'to', 'of', 'in',
  'for', 'on', 'with', 'at', 'by', 'from', 'as', 'into', 'through',
  'during', 'before', 'after', 'between', 'out', 'off', 'over', 'under',
  'again', 'then', 'once', 'here', 'there', 'when', 'where', 'why', 'how',
  'all', 'both', 'each', 'few', 'more', 'most', 'other', 'some', 'such',
  'no', 'nor', 'not', 'only', 'so', 'than', 'too', 'very', 'just', 'now',
  'what', 'which', 'who', 'this', 'that', 'these', 'those', 'or', 'and',
  'but', 'if', 'about', 'up', 'it', 'its', 'we', 'they', 'them', 'their',
  'my', 'your', 'our', 'his', 'her', 'i', 'me', 'he', 'she', 'you',
]);

/**
 * Tokenize a string: lowercase, strip punctuation, split on whitespace,
 * remove stopwords and single-character tokens.
 */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[?!.,;:'"()\[\]{}]/g, '')
    .split(/\s+/)
    .filter((t) => t.length > 1 && !TOKEN_STOPWORDS.has(t));
}

/**
 * Token overlap score between a query and document text (Q4-B).
 *
 * Computes the ratio of query tokens that appear in the document text
 * (case-insensitive, stopwords removed). Returns a value in [0, 1].
 *
 * @param query     Raw search query.
 * @param docText   Document text (summary + detail concatenated).
 * @returns Overlap ratio in [0, 1]. Returns 0 if query has no tokens.
 */
export function tokenOverlapScore(query: string, docText: string): number {
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) return 0;

  const docTokenSet = new Set(tokenize(docText));

  let matches = 0;
  for (const qt of queryTokens) {
    if (docTokenSet.has(qt)) matches++;
  }

  return matches / queryTokens.length;
}

// ---------------------------------------------------------------------------
// 6. Negation Awareness (from Q4-B)
// ---------------------------------------------------------------------------

/** Patterns that indicate negation context in decision text. */
const NEGATION_PATTERNS = [
  /\bnot\b/i,
  /\bdon'?t\b/i,
  /\bavoid\b/i,
  /\bnever\b/i,
  /\binstead\s+of\b/i,
  /\bshouldn'?t\b/i,
  /\bwon'?t\b/i,
  /\bcan'?t\b/i,
  /\bdoesn'?t\b/i,
  /\bwithout\b/i,
  /\bexclude\b/i,
  /\bdeprecated\b/i,
  /\babandoned\b/i,
  /\brejected\b/i,
];

/**
 * Negation awareness score (Q4-B).
 *
 * When the query contains negation intent, decisions that explicitly mention
 * the query terms in a negation context receive a boost. This catches
 * "what NOT to use for caching" matching "avoid Redis for caching".
 *
 * @param queryHasNegation  Whether the query was classified as having negation.
 * @param queryEntities     Key entities extracted from the query.
 * @param docText           Decision text to scan.
 * @returns Score in [0, 1]. 0 when query has no negation or doc has no negation context.
 */
export function negationAwarenessScore(
  queryHasNegation: boolean,
  queryEntities: string[],
  docText: string,
): number {
  if (!queryHasNegation || queryEntities.length === 0) return 0;

  const lower = docText.toLowerCase();

  // Check if the document contains negation language
  let hasNegationContext = false;
  for (const pattern of NEGATION_PATTERNS) {
    if (pattern.test(lower)) {
      hasNegationContext = true;
      break;
    }
  }
  if (!hasNegationContext) return 0;

  // Check how many query entities appear in the negation-context document
  let entityMatches = 0;
  for (const entity of queryEntities) {
    const re = new RegExp(`\\b${entity.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    if (re.test(lower)) entityMatches++;
  }

  if (entityMatches === 0) return 0;

  // Return ratio of matched entities, capped at 1.0
  return Math.min(1.0, entityMatches / queryEntities.length);
}

// ---------------------------------------------------------------------------
// 7. Freshness Boost for Related Decisions (from Q4-B)
// ---------------------------------------------------------------------------

/**
 * Compute a freshness bonus for a decision relative to other decisions
 * that share `affects` tags (Q4-B).
 *
 * Among decisions with overlapping `affects`, the more recent one gets
 * a small boost. Returns a value in [0, 1] based on the decision's
 * recency rank within its area peers.
 *
 * @param decisionId   The decision to compute freshness for.
 * @param createdAt    ISO-8601 timestamp of the decision.
 * @param affects      Affected areas of the decision.
 * @param allResults   Full result set to find area peers.
 * @returns Freshness boost in [0, 1]. 0 if no area peers exist.
 */
export function freshnessBoost(
  decisionId: string,
  createdAt: string,
  affects: string[],
  allResults: Array<{ id: string; created_at: string; affects: string[] }>,
): number {
  if (affects.length === 0 || allResults.length <= 1) return 0;

  // Find peers: other decisions sharing at least one `affects` tag
  const myAreas = new Set(affects);
  const peers: Array<{ id: string; time: number }> = [];

  for (const r of allResults) {
    if (r.id === decisionId) continue;
    const shared = r.affects.some((a) => myAreas.has(a));
    if (shared) {
      peers.push({ id: r.id, time: new Date(r.created_at).getTime() });
    }
  }

  if (peers.length === 0) return 0;

  const myTime = new Date(createdAt).getTime();

  // Count how many peers this decision is newer than
  let newerThanCount = 0;
  for (const peer of peers) {
    if (myTime > peer.time) newerThanCount++;
  }

  // Rank-based boost: 1.0 = newest among all peers, 0.0 = oldest
  return newerThanCount / peers.length;
}

// ---------------------------------------------------------------------------
// 8. Cluster Boost (Q5 — Knowledge Compression)
// ---------------------------------------------------------------------------

/**
 * Cluster membership boost signal.
 *
 * Decisions belonging to a cluster with 5+ members get a small boost.
 * The rationale: decisions in large clusters are part of well-established
 * patterns and carry higher collective weight.
 *
 * Returns 1.0 when the cluster has >= `minMembers`, 0.0 otherwise.
 * Weight should be kept low (e.g. 0.05) since this is a supplementary signal.
 *
 * @param clusterMemberCount  Number of decisions in the result's cluster (0 if no cluster).
 * @param minMembers  Minimum cluster size to trigger the boost (default 5).
 * @returns 0.0 or 1.0.
 */
export function clusterBoost(
  clusterMemberCount: number,
  minMembers: number = 5,
): number {
  return clusterMemberCount >= minMembers ? 1.0 : 0.0;
}
