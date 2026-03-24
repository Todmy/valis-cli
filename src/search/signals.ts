/**
 * Individual signal computation functions for multi-signal reranking.
 *
 * All functions are pure (no side effects, no DB calls), return values
 * in the 0-1 range, and are designed for <10ms total on 50 results.
 *
 * @module search/signals
 * @phase 003-search-growth (T005)
 */

import type { SearchResult } from '../types.js';

// ---------------------------------------------------------------------------
// 1. Recency Decay
// ---------------------------------------------------------------------------

/**
 * Exponential decay based on decision age.
 *
 * Formula: `Math.pow(0.5, ageDays / halfLifeDays)`
 *
 * Returns 1.0 for brand-new decisions, 0.5 at the half-life,
 * and asymptotically approaches 0.0 for very old decisions.
 *
 * Pinned decisions are exempt from decay — always return 1.0.
 *
 * @param createdAt  ISO-8601 timestamp of decision creation.
 * @param halfLifeDays  Number of days until score halves (default 90).
 * @param pinned  Whether the decision is pinned (exempt from decay).
 * @param now  Optional current timestamp for testing (defaults to Date.now()).
 * @returns Signal value in [0, 1].
 */
export function recencyDecay(
  createdAt: string,
  halfLifeDays: number = 90,
  pinned: boolean = false,
  now: number = Date.now(),
): number {
  if (pinned) return 1.0;

  const ageDays = (now - new Date(createdAt).getTime()) / 86_400_000;
  if (ageDays <= 0) return 1.0;

  return Math.pow(0.5, ageDays / halfLifeDays);
}

// ---------------------------------------------------------------------------
// 2. Importance Score
// ---------------------------------------------------------------------------

/**
 * Importance signal combining confidence and pin boost.
 *
 * Base confidence defaults to 0.5 when null/undefined.
 * Pinned decisions get a 2x boost, capped at 1.0.
 *
 * @param confidence  Decision confidence (0-1), nullable.
 * @param pinned  Whether the decision is pinned.
 * @returns Signal value in [0, 1].
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
// 3. Graph Connectivity
// ---------------------------------------------------------------------------

/**
 * Graph connectivity signal based on inbound dependency count.
 *
 * Counts how many other results in the set reference `decisionId` in
 * their `depends_on` array. Normalized via log1p to dampen outliers,
 * then min-max normalized within the result set.
 *
 * When the result set has no inbound references at all, returns 0.0
 * for all decisions (no connectivity signal).
 *
 * @param decisionId  The ID of the decision to score.
 * @param allResults  The full result set to compute connectivity within.
 * @returns Signal value in [0, 1].
 */
export function graphConnectivity(
  decisionId: string,
  allResults: SearchResult[],
): number {
  // Compute raw inbound counts for all results
  const counts = computeInboundCounts(allResults);
  const raw = counts.get(decisionId) ?? 0;

  // Apply log1p dampening
  const logged = Math.log1p(raw);

  // Find max log1p in set for normalization
  let maxLogged = 0;
  for (const count of counts.values()) {
    const l = Math.log1p(count);
    if (l > maxLogged) maxLogged = l;
  }

  if (maxLogged === 0) return 0.0;
  return logged / maxLogged;
}

/**
 * Precompute inbound dependency counts for all results.
 *
 * For each result, count how many other results reference its ID
 * in their `depends_on` array.
 *
 * @returns Map of decisionId -> inbound count
 */
export function computeInboundCounts(
  results: SearchResult[],
): Map<string, number> {
  const counts = new Map<string, number>();

  // Initialize all IDs to 0
  for (const r of results) {
    counts.set(r.id, 0);
  }

  // Count inbound references
  const idSet = new Set(results.map((r) => r.id));
  for (const r of results) {
    if (!r.depends_on) continue;
    for (const depId of r.depends_on) {
      if (idSet.has(depId)) {
        counts.set(depId, (counts.get(depId) ?? 0) + 1);
      }
    }
  }

  return counts;
}

// ---------------------------------------------------------------------------
// 4. BM25 Normalization
// ---------------------------------------------------------------------------

/**
 * Min-max normalize BM25 scores to [0, 1].
 *
 * Raw BM25 scores are unbounded (0.0+). This normalizes them within
 * the result set so the highest score maps to 1.0 and lowest to 0.0.
 *
 * Edge cases:
 * - All scores equal: return 0.5 for all.
 * - Empty array: return empty array.
 * - Single item: return 0.5.
 *
 * @param scores  Raw BM25 scores in result order.
 * @returns Normalized scores in [0, 1], same length and order.
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
    // All equal (or single item) — return 0.5
    return scores.map(() => 0.5);
  }

  return scores.map((s) => (s - min) / range);
}
