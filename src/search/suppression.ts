/**
 * Within-area result suppression.
 *
 * After reranking, groups results by their `affects` areas and suppresses
 * redundant results where a dominant result exists.
 *
 * Algorithm:
 * 1. Group results by each `affects` area (one result may appear in multiple groups).
 * 2. For each area group with 2+ results, sorted by composite_score descending:
 *    - If `topScore > threshold * secondScore` (dominant): keep only top, suppress rest.
 *    - Otherwise (non-dominant): keep top 2, suppress rest.
 * 3. A result is truly suppressed only if it is suppressed in ALL of its area groups.
 *    Cross-area results (visible in at least one group) remain visible.
 * 4. Results with empty `affects` are exempt from suppression (cannot be grouped).
 *
 * Default threshold: 1.5x score ratio.
 *
 * @module search/suppression
 */

import type { RerankedResult } from '../types.js';

/** Default suppression threshold — top must exceed 1.5x second to be dominant. */
export const DEFAULT_SUPPRESSION_THRESHOLD = 1.5;

export interface SuppressionOutput {
  /** Visible results (includes suppressed items only when includeAll is true). */
  visible: RerankedResult[];
  /** Count of results that were suppressed. */
  suppressed_count: number;
}

/**
 * Apply within-area suppression to reranked results.
 *
 * @param results     Reranked results sorted by composite_score (descending).
 * @param threshold   Score ratio for dominant-result detection (default 1.5).
 * @param includeAll  If true, suppressed results are included in `visible`
 *                    with `suppressed: true` (the --all flag).
 * @returns Visible results and the count of suppressed items.
 */
export function suppressResults(
  results: RerankedResult[],
  threshold: number = DEFAULT_SUPPRESSION_THRESHOLD,
  includeAll: boolean = false,
): SuppressionOutput {
  if (results.length === 0) {
    return { visible: [], suppressed_count: 0 };
  }

  // --- Step 1: Group by affects area --------------------------------------
  const areaGroups = new Map<string, RerankedResult[]>();

  for (const r of results) {
    if (!r.affects || r.affects.length === 0) continue; // exempt
    for (const area of r.affects) {
      let group = areaGroups.get(area);
      if (!group) {
        group = [];
        areaGroups.set(area, group);
      }
      group.push(r);
    }
  }

  // --- Step 2: Determine suppressed IDs per area --------------------------
  const suppressedInArea = new Map<string, Set<string>>(); // area -> suppressed IDs

  for (const [area, group] of areaGroups) {
    if (group.length < 2) continue;

    // Sort descending by composite_score (results may already be sorted
    // globally but not necessarily within each area group)
    const sorted = [...group].sort((a, b) => b.composite_score - a.composite_score);
    const topScore = sorted[0].composite_score;
    const secondScore = sorted[1].composite_score;

    const suppressed = new Set<string>();

    if (secondScore > 0 && topScore > threshold * secondScore) {
      // Dominant result — suppress all except top
      for (let i = 1; i < sorted.length; i++) {
        suppressed.add(sorted[i].id);
      }
    } else {
      // Non-dominant — suppress below top 2
      for (let i = 2; i < sorted.length; i++) {
        suppressed.add(sorted[i].id);
      }
    }

    suppressedInArea.set(area, suppressed);
  }

  // --- Step 3: A result is truly suppressed only if suppressed in ALL -----
  //     of its area groups.
  const trulySuppressed = new Set<string>();

  for (const r of results) {
    if (!r.affects || r.affects.length === 0) continue; // exempt — never suppressed

    // Check if this result is suppressed in every area group it belongs to
    let suppressedInAllGroups = true;
    for (const area of r.affects) {
      const areaSet = suppressedInArea.get(area);
      if (!areaSet || !areaSet.has(r.id)) {
        // Not suppressed in this area group (or group too small)
        suppressedInAllGroups = false;
        break;
      }
    }

    if (suppressedInAllGroups) {
      trulySuppressed.add(r.id);
    }
  }

  // --- Step 4: Build output -----------------------------------------------
  const visible: RerankedResult[] = [];
  for (const r of results) {
    if (trulySuppressed.has(r.id)) {
      if (includeAll) {
        visible.push({ ...r, suppressed: true });
      }
      // else: omit from visible
    } else {
      visible.push(r);
    }
  }

  return {
    visible,
    suppressed_count: trulySuppressed.size,
  };
}
