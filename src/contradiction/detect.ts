import type { SupabaseClient } from '@supabase/supabase-js';
import type { QdrantClient } from '@qdrant/js-client-rest';
import type { Decision, StoreContradictionWarning } from '../types.js';
import { getSimilaritiesForNewDecision } from '../cloud/qdrant.js';
import type { OppositionClassifier, DecisionLite } from './classify.js';

// ---------------------------------------------------------------------------
// 044 — Opposition-gate constants
// ---------------------------------------------------------------------------

/** Max candidate decisions to fetch (recall) on the store hot path. */
const CANDIDATE_FETCH_LIMIT = 200;

/** Top-K most-similar survivors classified inline per store (FR-011). */
const CLASSIFY_TOP_K = 5;

/**
 * Temporal-cue phrases that signal a direction change ("we dropped X, moving to
 * Y"). A nominee carrying a cue is force-classified even if it falls outside the
 * top-K cosine cut — NLI/LLM opposition signals are weak on temporal reversal,
 * so the cue is the cheap recall lever (research R3 / SC-002).
 */
const TEMPORAL_CUES: RegExp[] = [
  /\bdropping\b/i,
  /\bmoving to\b/i,
  /\bswitch(?:ed|ing)?\s+(?:from|to)\b/i,
  /\bno longer\b/i,
  /\binstead of\b/i,
  /\breplac(?:e|ed|ing)\b/i,
  /\bdeprecat/i,
];

function hasTemporalCue(text: string): boolean {
  return TEMPORAL_CUES.some((re) => re.test(text));
}

function toLite(d: Pick<Decision, 'id' | 'summary' | 'detail'>): DecisionLite {
  return { id: d.id, summary: d.summary ?? null, detail: d.detail };
}

// ---------------------------------------------------------------------------
// 044 — Opposition-gate detection (replaces the similarity-only trigger)
// ---------------------------------------------------------------------------

/**
 * Detect contradictions between a newly stored decision and existing decisions
 * in the same project, using an **opposition gate** (feature 044) instead of
 * the old similarity-only trigger.
 *
 * Cascade:
 *  - **Stage 0 (recall)**: query `active`+`proposed` candidates whose `affects`
 *    overlap, and (when Qdrant is up) their cosine similarity. Tag overlap and
 *    cosine are *nominators only* — neither flags a contradiction by itself
 *    (FR-001/FR-002).
 *  - **Cap**: classify only the top-K (5) most-similar survivors, plus any
 *    nominee carrying a temporal cue (FR-011).
 *  - **Stage 1 (verdict)**: classify each capped pair via `classifier`.
 *  - **Stage 2 (act by branch)**: `compatible` → suppress (no row);
 *    `genuine_conflict`/`replacement` → contradiction row + cached verdict
 *    (replacement also carries a propose-supersede signal — escalate-first, no
 *    auto state change); `uncertain` → row surfaced low-confidence (FR-008).
 *
 * **Constitution IV (no LLM dependency for core ops)**: the `classifier` is
 * optional. Without it the gate degrades OFF — no opposition signal means no
 * contradiction claims — rather than flagging on similarity alone. The store
 * write is never blocked: a throwing classifier resolves to an abstention.
 *
 * Detection runs for both `active` and `proposed` new decisions (#71).
 *
 * @returns List of {@link StoreContradictionWarning} for the store response.
 */
export async function detectContradictions(
  supabase: SupabaseClient,
  qdrant: QdrantClient | null,
  orgId: string,
  newDecision: Decision,
  classifier?: OppositionClassifier,
): Promise<StoreContradictionWarning[]> {
  const warnings: StoreContradictionWarning[] = [];

  if (!newDecision.affects || newDecision.affects.length === 0) {
    return warnings;
  }

  // Constitution IV: opposition detection is an optional LLM feature. Absent a
  // classifier the gate is OFF (no opposition signal → no contradiction claims).
  if (!classifier) {
    return warnings;
  }

  const projectId = newDecision.project_id || undefined;

  // --- Stage 0: candidate recall (unchanged query; nominators only) ---
  let candidates: Decision[];
  try {
    let query = supabase
      .from('decisions')
      .select('id,affects,summary,author,detail')
      .eq('org_id', orgId)
      .in('status', ['active', 'proposed'])
      .neq('id', newDecision.id)
      .overlaps('affects', newDecision.affects)
      .limit(CANDIDATE_FETCH_LIMIT);
    if (projectId) query = query.eq('project_id', projectId);
    const { data, error } = await query;
    if (error) throw error;
    candidates = (data || []) as Decision[];
  } catch {
    return warnings;
  }
  if (candidates.length === 0) return warnings;

  let similarityById = new Map<string, number>();
  if (qdrant) {
    similarityById = await getSimilaritiesForNewDecision(
      qdrant,
      orgId,
      newDecision.id,
      candidates.map((c) => c.id),
    );
  }

  type Nominee = { c: Decision; overlap: string[]; sim: number | null };
  const nominees: Nominee[] = candidates
    .map((c) => ({
      c,
      overlap: (newDecision.affects || []).filter((a) => (c.affects || []).includes(a)),
      sim: similarityById.has(c.id) ? (similarityById.get(c.id) as number) : null,
    }))
    .filter((n) => n.overlap.length > 0);

  // --- Cap: top-K by cosine + temporal-cue force-include (FR-011) ---
  const newCarriesCue = hasTemporalCue(`${newDecision.summary ?? ''} ${newDecision.detail}`);
  const sorted = [...nominees].sort((a, b) => (b.sim ?? -1) - (a.sim ?? -1));
  const capped = new Map<string, Nominee>();
  for (const n of sorted.slice(0, CLASSIFY_TOP_K)) capped.set(n.c.id, n);
  for (const n of nominees) {
    // A temporal change in the NEW decision, or a cue in the candidate, forces
    // classification even below the cosine cut.
    if (newCarriesCue || hasTemporalCue(`${n.c.summary ?? ''} ${n.c.detail}`)) {
      capped.set(n.c.id, n);
    }
  }

  // --- Stage 1: classify the capped set in parallel ---
  // Defensive: a misbehaving classifier MUST NOT block the store (Constitution
  // III/IV). A throw maps to an abstention, never propagates.
  const safeClassify = async (cand: Decision) => {
    try {
      return await classifier(toLite(newDecision), toLite(cand));
    } catch {
      return {
        classification: 'uncertain' as const,
        confidence: 0,
        abstained: true,
        reason: 'classifier_error',
      };
    }
  };
  const assessed = await Promise.all(
    [...capped.values()].map(async (n) => ({ n, verdict: await safeClassify(n.c) })),
  );

  // --- Stage 2: act by branch ---
  for (const { n, verdict } of assessed) {
    const candidate = n.c;

    // Defensive: a "no classifier" abstention means the gate had no signal at
    // all → do not surface (degrade OFF, not flood `uncertain`).
    if (verdict.abstained && verdict.reason === 'no_classifier') continue;

    // `compatible` → suppress at source (the core false-positive fix).
    if (verdict.classification === 'compatible') continue;

    const [decisionAId, decisionBId] =
      newDecision.id < candidate.id
        ? [newDecision.id, candidate.id]
        : [candidate.id, newDecision.id];

    // Honour the existing pair (dedup + 042 `suppressed`, FR-010).
    let existing: { id: string; suppressed: boolean | null } | null = null;
    try {
      const { data } = await supabase
        .from('contradictions')
        .select('id,suppressed')
        .eq('decision_a_id', decisionAId)
        .eq('decision_b_id', decisionBId)
        .maybeSingle();
      existing = (data as unknown as { id: string; suppressed: boolean | null } | null) ?? null;
    } catch {
      // Non-fatal — fall through to insert (unique constraint catches dupes).
    }
    if (existing?.suppressed) continue; // FR-010 — dismissed-compatible stays dismissed.

    const confidence = verdict.abstained ? null : verdict.confidence;
    const warning: StoreContradictionWarning = {
      decision_id: candidate.id,
      summary: candidate.summary || candidate.detail.substring(0, 80),
      author: candidate.author,
      overlap_areas: n.overlap,
      similarity: n.sim,
      verdict_classification: verdict.classification,
      verdict_confidence: confidence,
    };
    // `replacement`: propose (never apply) that the NEWER decision supersede the
    // older — escalate-first, FR-004 (Graphiti recency: the new decision wins).
    if (verdict.classification === 'replacement') {
      warning.propose_supersede = {
        superseded_id: candidate.id,
        supersedes_id: newDecision.id,
      };
    }

    if (existing) {
      warnings.push(warning);
      continue;
    }

    const record: Record<string, unknown> = {
      org_id: orgId,
      decision_a_id: decisionAId,
      decision_b_id: decisionBId,
      overlap_areas: n.overlap,
      similarity_score: n.sim,
      status: 'open',
      verdict_classification: verdict.classification,
      verdict_confidence: confidence,
      verdict_assessed_at: new Date().toISOString(),
    };
    if (projectId) record.project_id = projectId;
    try {
      await supabase.from('contradictions').insert(record);
    } catch {
      // Unique-constraint or other failure — non-fatal.
    }
    warnings.push(warning);
  }

  return warnings;
}

// ---------------------------------------------------------------------------
// T023 — Contradiction resolution (CLI-side helper)
// ---------------------------------------------------------------------------

/**
 * Result of resolving contradictions for a decision.
 */
export interface ResolvedContradiction {
  contradiction_id: string;
  decision_a_id: string;
  decision_b_id: string;
  overlap_areas: string[];
}

/**
 * Resolve open contradictions involving a given decision.
 *
 * Called from the store pipeline after the `change-status` Edge Function
 * returns (the Edge Function handles the SQL UPDATE directly; this helper
 * updates local state and builds channel events).
 *
 * The Edge Function already runs:
 * ```sql
 * UPDATE contradictions
 *   SET status = 'resolved', resolved_at = now()
 *   WHERE (decision_a_id = $1 OR decision_b_id = $1) AND status = 'open';
 * ```
 *
 * This CLI-side function queries the freshly resolved contradictions so the
 * caller can build channel events and return them in the response.
 *
 * @returns List of resolved contradiction records.
 */
export async function resolveContradictions(
  supabase: SupabaseClient,
  decisionId: string,
): Promise<ResolvedContradiction[]> {
  try {
    // Query contradictions that were just resolved by the Edge Function
    // (status = 'resolved' and involving the given decision)
    const { data, error } = await supabase
      .from('contradictions')
      .select('id, decision_a_id, decision_b_id, overlap_areas')
      .or(`decision_a_id.eq.${decisionId},decision_b_id.eq.${decisionId}`)
      .eq('status', 'resolved')
      .order('resolved_at', { ascending: false });

    if (error) throw error;

    return (data || []).map((row) => ({
      contradiction_id: row.id as string,
      decision_a_id: row.decision_a_id as string,
      decision_b_id: row.decision_b_id as string,
      overlap_areas: (row.overlap_areas as string[]) || [],
    }));
  } catch {
    // Non-fatal — contradiction resolution query failed
    return [];
  }
}
