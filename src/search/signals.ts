/**
 * Individual signal computation functions for the multi-signal reranker.
 *
 * Each function produces a value in [0, 1] suitable for weighted combination.
 *
 * @module search/signals
 */

// ---------------------------------------------------------------------------
// 1. Recency Decay
// ---------------------------------------------------------------------------

const MS_PER_DAY = 86_400_000;

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
// 3. Graph Connectivity
// ---------------------------------------------------------------------------

/**
 * Graph connectivity signal based on inbound dependency count.
 *
 * For each result, counts how many other results in the set reference it
 * in their `depends_on` array. Normalized via `log1p(deps) / log1p(maxDeps)`
 * to compress the range and reduce outlier influence.
 *
 * When `maxDeps` is 0 (no dependencies in the result set), returns 0 for all.
 *
 * @param decisionId  The decision ID to compute connectivity for.
 * @param allResults  The full set of results to count inbound references within.
 * @returns A value in [0, 1].
 */
export function graphConnectivity(
  decisionId: string,
  allResults: Array<{ id: string; depends_on?: string[] }>,
): number {
  // Count inbound references: how many results depend on this decision
  let inbound = 0;
  let maxInbound = 0;

  // First pass: count inbound for every result to find the max
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

  inbound = inboundCounts.get(decisionId) ?? 0;

  if (maxInbound === 0) return 0;
  return Math.log1p(inbound) / Math.log1p(maxInbound);
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
