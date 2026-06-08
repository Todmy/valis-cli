/**
 * 044/T017: one-off backfill of the opposition gate over EXISTING open
 * contradictions (FR-014). The gate only changes NEW stores; the corpus
 * detected before it shipped still carries the false-positive flood (e.g. the
 * copywriter-KB 6-row case). This sweep re-classifies every open pair:
 *   - `compatible`            → suppress (reversible, logged) — clears the flood
 *   - `genuine_conflict` /
 *     `replacement`           → keep open, cache the verdict
 *   - `uncertain` (abstain)   → keep open, counted (not suppressed)
 *
 * Suppressing a false-positive contradiction changes NO decision's status, so
 * the sweep may auto-suppress without per-pair confirmation (consistent with
 * FR-007). It is reversible (the `suppressed` flag) and observable (returns
 * counts; the caller writes a `contradiction_backfill` audit event).
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { OppositionClassifier, DecisionLite } from './classify.js';

export interface BackfillResult {
  scanned: number;
  suppressed: number;
  retained: number;
  abstained: number;
}

export interface BackfillOptions {
  /** Report counts without writing. */
  dryRun?: boolean;
  /** Scope the sweep to a single project. */
  projectId?: string;
}

interface OpenPair {
  id: string;
  decision_a_id: string;
  decision_b_id: string;
}

function toLite(d: { id: string; summary: string | null; detail: string }): DecisionLite {
  return { id: d.id, summary: d.summary ?? null, detail: d.detail };
}

export async function backfillOppositionVerdicts(
  supabase: SupabaseClient,
  classifier: OppositionClassifier,
  opts: BackfillOptions = {},
): Promise<BackfillResult> {
  const result: BackfillResult = { scanned: 0, suppressed: 0, retained: 0, abstained: 0 };

  // Fetch open, not-already-suppressed pairs.
  let query = supabase
    .from('contradictions')
    .select('id,decision_a_id,decision_b_id')
    .eq('status', 'open')
    .eq('suppressed', false);
  if (opts.projectId) query = query.eq('project_id', opts.projectId);

  let pairs: OpenPair[];
  try {
    const { data, error } = await query;
    if (error) throw error;
    pairs = (data || []) as OpenPair[];
  } catch {
    return result; // non-fatal: nothing scanned
  }

  for (const pair of pairs) {
    result.scanned++;

    // Load both decisions' text.
    let rows: Array<{ id: string; summary: string | null; detail: string }>;
    try {
      const { data } = await supabase
        .from('decisions')
        .select('id,summary,detail')
        .in('id', [pair.decision_a_id, pair.decision_b_id]);
      rows = (data || []) as typeof rows;
    } catch {
      result.abstained++;
      continue;
    }
    const a = rows.find((r) => r.id === pair.decision_a_id);
    const b = rows.find((r) => r.id === pair.decision_b_id);
    if (!a || !b) {
      // A decision was deleted out from under the pair — leave it untouched.
      result.abstained++;
      continue;
    }

    let verdict;
    try {
      verdict = await classifier(toLite(a), toLite(b));
    } catch {
      result.abstained++;
      continue;
    }

    if (verdict.abstained || verdict.classification === 'uncertain') {
      result.abstained++;
      continue;
    }

    if (verdict.classification === 'compatible') {
      result.suppressed++;
      if (!opts.dryRun) {
        try {
          await supabase
            .from('contradictions')
            .update({
              suppressed: true,
              verdict_classification: 'compatible',
              verdict_confidence: verdict.confidence,
              verdict_assessed_at: new Date().toISOString(),
            })
            .eq('id', pair.id);
        } catch {
          // Non-fatal — count stays, the row simply was not updated.
        }
      }
    } else {
      // genuine_conflict | replacement — keep open, cache the verdict.
      result.retained++;
      if (!opts.dryRun) {
        try {
          await supabase
            .from('contradictions')
            .update({
              verdict_classification: verdict.classification,
              verdict_confidence: verdict.confidence,
              verdict_assessed_at: new Date().toISOString(),
            })
            .eq('id', pair.id);
        } catch {
          // Non-fatal.
        }
      }
    }
  }

  return result;
}
