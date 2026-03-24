/**
 * Within-area result suppression to reduce noise in search results.
 *
 * Groups reranked results by `affects` area and suppresses redundant
 * results within each area group. Cross-area results (appearing in
 * non-suppressed groups) remain visible.
 *
 * All operations are pure, in-memory — no DB calls.
 *
 * @module search/suppression
 * @phase 003-search-growth (T007)
 */

import type { RerankedResult } from '../types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SuppressionResult {
  /** Results to show (includes suppressed items only when includeAll=true). */
  visible: RerankedResult[];
  /** Number of results suppressed from default view. */
  suppressed_count: number;
}

// ---------------------------------------------------------------------------
// Suppression
// ---------------------------------------------------------------------------

/**
 * Suppress redundant results within the same `affects` area.
 *
 * Algorithm:
 * 1. Group results by affects area (a result appears in multiple groups).
 * 2. For each group with 2+ results, sorted by composite_score:
 *    - If top score > threshold * second score: keep top only (dominant).
 *    - Otherwise: keep top 2, suppress rest (non-dominant).
 * 3. A result is truly suppressed only if it is suppressed in ALL of
 *    its area groups. Cross-area results remain visible.
 * 4. Results with empty affects are exempt from suppression.
 *
 * @param results  Reranked results (already sorted by composite_score).
 * @param threshold  Score ratio for dominant result detection (default 1.5).
 * @param includeAll  When true, include suppressed results with label.
 * @returns Visible results and suppressed count.
 */
export function suppressResults(
  results: RerankedResult[],
  threshold: number = 1.5,
  includeAll: boolean = false,
): SuppressionResult {
  if (results.length === 0) {
    return { visible: [], suppressed_count: 0 };
  }

  // Step 1: Group by affects area
  const areaGroups = groupByAffectsArea(results);

  // Step 2: Determine which results are suppressed per area group
  const suppressedInArea = new Set<string>();
  const areaGroupsForId = new Map<string, string[]>();

  // Build area membership for each result
  for (const result of results) {
    if (!result.affects || result.affects.length === 0) continue;
    areaGroupsForId.set(result.id, result.affects);
  }

  for (const [_area, group] of areaGroups) {
    if (group.length < 2) continue;

    // Sort by composite_score descending
    const sorted = [...group].sort(
      (a, b) => b.composite_score - a.composite_score,
    );
    const topScore = sorted[0].composite_score;
    const secondScore = sorted[1].composite_score;

    if (secondScore > 0 && topScore > threshold * secondScore) {
      // Dominant result — suppress all except top
      for (let i = 1; i < sorted.length; i++) {
        suppressedInArea.add(`${_area}:${sorted[i].id}`);
      }
    } else {
      // No dominant result — suppress below top 2
      for (let i = 2; i < sorted.length; i++) {
        suppressedInArea.add(`${_area}:${sorted[i].id}`);
      }
    }
  }

  // Step 3: A result is truly suppressed only if suppressed in ALL its area groups
  const trulySuppressed = new Set<string>();

  for (const result of results) {
    const areas = areaGroupsForId.get(result.id);
    if (!areas || areas.length === 0) continue; // No affects — never suppressed

    const allSuppressed = areas.every((area) => {
      const group = areaGroups.get(area);
      // If the group has <2 items, this result can't be suppressed in it
      if (!group || group.length < 2) return false;
      return suppressedInArea.has(`${area}:${result.id}`);
    });

    if (allSuppressed) {
      trulySuppressed.add(result.id);
    }
  }

  // Step 4: Build output
  const visible: RerankedResult[] = [];
  for (const result of results) {
    if (trulySuppressed.has(result.id)) {
      const marked = { ...result, suppressed: true };
      if (includeAll) {
        visible.push(marked);
      }
    } else {
      visible.push(result);
    }
  }

  return {
    visible,
    suppressed_count: trulySuppressed.size,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Group results by their `affects` areas.
 * A result with multiple affects entries appears in multiple groups.
 * Results with empty or missing affects are excluded.
 */
export function groupByAffectsArea(
  results: RerankedResult[],
): Map<string, RerankedResult[]> {
  const groups = new Map<string, RerankedResult[]>();

  for (const result of results) {
    if (!result.affects || result.affects.length === 0) continue;

    for (const area of result.affects) {
      const group = groups.get(area);
      if (group) {
        group.push(result);
      } else {
        groups.set(area, [result]);
      }
    }
  }

  return groups;
}
