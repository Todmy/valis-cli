/**
 * Template-based group summary generation for knowledge compression.
 *
 * No LLM dependency — uses structural rules to merge decision texts:
 * 1. Group decisions by `affects` tags
 * 2. Take the most recent decision's text as the base
 * 3. Append unique information from older decisions
 *
 * @module synthesis/summarize
 */

import type { Decision } from '../types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract the first sentence (or first 120 chars) as a short summary.
 */
function shortSummary(decision: Decision): string {
  const text = decision.summary ?? decision.detail;
  if (!text) return decision.id.slice(0, 8);

  // First sentence: up to first period followed by space or end
  const match = text.match(/^(.+?[.!?])(?:\s|$)/);
  if (match && match[1].length <= 120) return match[1];

  // Fallback: first 120 chars
  return text.length <= 120 ? text : text.slice(0, 117) + '...';
}

/**
 * Extract unique phrases from a text that aren't present in the base text.
 * Uses sentence-level comparison (simple but effective for template-based merge).
 */
function uniqueSentences(text: string, baseText: string): string[] {
  const baseLower = baseText.toLowerCase();
  const sentences = text
    .split(/[.!?]\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 10);

  return sentences.filter((s) => !baseLower.includes(s.toLowerCase()));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * Generate a template-based summary for a group of related decisions.
 *
 * Format:
 *   ## {Affects Area}
 *   {N} related decisions:
 *   - {decision1 summary}
 *   - {decision2 summary}
 *
 *   Consolidated: {merged text}
 */
export function generateGroupSummary(decisions: Decision[]): string {
  if (decisions.length === 0) return '';
  if (decisions.length === 1) {
    return decisions[0].summary ?? decisions[0].detail;
  }

  // Group by affects tags
  const areaDecisions = new Map<string, Decision[]>();
  for (const d of decisions) {
    const areas = d.affects && d.affects.length > 0 ? d.affects : ['general'];
    for (const area of areas) {
      const arr = areaDecisions.get(area) ?? [];
      arr.push(d);
      areaDecisions.set(area, arr);
    }
  }

  // Deduplicate: find the primary area grouping (covering most decisions)
  // to avoid repeating the same decisions under multiple headings
  const sortedAreas = [...areaDecisions.entries()]
    .sort((a, b) => b[1].length - a[1].length);

  const coveredIds = new Set<string>();
  const sections: string[] = [];

  for (const [area, areaDecisions_] of sortedAreas) {
    const uncovered = areaDecisions_.filter((d) => !coveredIds.has(d.id));
    if (uncovered.length === 0) continue;

    for (const d of uncovered) coveredIds.add(d.id);

    // Sort decisions newest-first
    const sorted = [...uncovered].sort(
      (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
    );

    const lines: string[] = [];
    lines.push(`## ${area}`);
    lines.push(`${sorted.length} related decision(s):`);

    for (const d of sorted) {
      lines.push(`- ${shortSummary(d)}`);
    }

    // Consolidated text: newest decision as base, unique info from others
    const newest = sorted[0];
    const baseText = newest.summary ?? newest.detail;
    const extras: string[] = [];

    for (let i = 1; i < sorted.length; i++) {
      const otherText = sorted[i].summary ?? sorted[i].detail;
      if (!otherText) continue;
      const unique = uniqueSentences(otherText, baseText);
      extras.push(...unique);
    }

    lines.push('');
    if (extras.length > 0) {
      lines.push(`Consolidated: ${baseText} Additionally: ${extras.join('. ')}.`);
    } else {
      lines.push(`Consolidated: ${baseText}`);
    }

    sections.push(lines.join('\n'));
  }

  return sections.join('\n\n');
}
