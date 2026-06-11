/**
 * 045 Find Gaps — knowledge-state fingerprint (research R5).
 *
 * `knowledgeStateHash` is a SHA-256 over the sorted `(decision_id, updated_at)`
 * pairs of the project's ACTIVE decisions. It is computed at run start, stored
 * on `gap_runs.knowledge_state_hash`, and stamped onto every `gap_event`.
 *
 * Two uses:
 *   - skip-run short-circuit: an unchanged hash (and no new candidate component)
 *     means the recorded knowledge has not moved, so a re-run completes instantly
 *     with zero model calls (FR-019 / SC-006);
 *   - event attribution: which knowledge version a lifecycle action was taken
 *     against (FR-024).
 *
 * `updated_at` already changes on every content mutation, so hashing it is
 * sufficient — hashing the full decision text would add cost without precision.
 */

import { createHash } from 'node:crypto';
import type { DecisionLite } from './llm.js';

/** Minimal shape of a `decisions` row this module needs. */
export interface DecisionRow {
  id: string;
  summary: string | null;
  detail: string;
  affects: string[] | null;
  status: string;
  updated_at: string;
}

/** Map a raw `decisions` row to the engine's `DecisionLite` projection. */
export function toDecisionLite(row: DecisionRow): DecisionLite {
  return {
    id: row.id,
    summary: row.summary,
    detail: row.detail,
    affects: row.affects ?? [],
    status: row.status,
    updated_at: row.updated_at,
  };
}

/**
 * SHA-256 fingerprint of the project's ACTIVE knowledge state. Only `status`
 * === 'active' decisions contribute (proposed/deprecated/superseded do not move
 * the analyzed surface). Stable under reordering — pairs are sorted by id first.
 */
export function knowledgeStateHash(decisions: DecisionLite[]): string {
  const active = decisions
    .filter((d) => d.status === 'active')
    .map((d) => `${d.id}:${d.updated_at}`)
    .sort();
  const hash = createHash('sha256');
  hash.update(active.join('\n'));
  return hash.digest('hex');
}
