import type { SupabaseClient } from '@supabase/supabase-js';
import type { QdrantClient } from '@qdrant/js-client-rest';
import type {
  Decision,
  Contradiction,
  StoreContradictionWarning,
} from '../types.js';
import { getSimilarity } from '../cloud/qdrant.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Minimum cosine similarity to flag a contradiction when Qdrant is available. */
const SIMILARITY_THRESHOLD = 0.7;

// ---------------------------------------------------------------------------
// T021 — Two-tier contradiction detection
// ---------------------------------------------------------------------------

/**
 * Detect potential contradictions between a newly stored decision and existing
 * active decisions in the same org.
 *
 * **Tier 1 (always)**: Query active decisions whose `affects` arrays overlap
 * with the new decision via the Postgres `&&` (array overlap) operator.
 *
 * **Tier 2 (when Qdrant available)**: For each candidate, compute cosine
 * similarity in Qdrant.  Flag only if similarity > 0.7.  When Qdrant is
 * unavailable, area overlap alone is sufficient (Tier 1 only).
 *
 * Detected contradictions are inserted into the `contradictions` table with
 * ordered pairs (smaller UUID as `decision_a_id`) to prevent duplicates.
 *
 * @returns List of {@link StoreContradictionWarning} for the store response.
 */
export async function detectContradictions(
  supabase: SupabaseClient,
  qdrant: QdrantClient | null,
  orgId: string,
  newDecision: Decision,
): Promise<StoreContradictionWarning[]> {
  const warnings: StoreContradictionWarning[] = [];

  // Nothing to compare if the new decision has no affects areas
  if (!newDecision.affects || newDecision.affects.length === 0) {
    return warnings;
  }

  // Only compare against active decisions
  if (newDecision.status !== 'active') {
    return warnings;
  }

  // T026: Resolve project_id from the decision — contradictions are scoped within
  // a single project. Cross-project contradictions are not possible by design.
  const projectId = newDecision.project_id || undefined;

  // ------------------------------------------------------------------
  // Tier 1: Find candidates with overlapping affects via SQL &&
  // ------------------------------------------------------------------

  let candidates: Decision[];
  try {
    const rpcParams: Record<string, unknown> = {
      p_org_id: orgId,
      p_affects: newDecision.affects,
      p_exclude_id: newDecision.id,
      p_project_id: projectId || null,
    };

    const { data, error } = await supabase.rpc('find_contradiction_candidates', rpcParams);

    if (error) throw error;
    candidates = (data || []) as Decision[];
  } catch {
    // RPC may not exist yet — fall back to client-side filtering
    try {
      let query = supabase
        .from('decisions')
        .select('*')
        .eq('org_id', orgId)
        .eq('status', 'active')
        .neq('id', newDecision.id)
        .overlaps('affects', newDecision.affects);

      // T026: Scope fallback query to project
      if (projectId) {
        query = query.eq('project_id', projectId);
      }

      const { data, error } = await query;

      if (error) throw error;
      candidates = (data || []) as Decision[];
    } catch {
      // If both approaches fail, skip contradiction detection
      return warnings;
    }
  }

  if (candidates.length === 0) {
    return warnings;
  }

  // ------------------------------------------------------------------
  // Tier 2: Compute similarity + insert contradictions
  // ------------------------------------------------------------------

  for (const candidate of candidates) {
    // Compute overlap areas between the two decisions
    const overlapAreas = (newDecision.affects || []).filter((area) =>
      (candidate.affects || []).includes(area),
    );

    if (overlapAreas.length === 0) continue;

    let similarity = 0;
    let qdrantAvailable = false;

    // Try Qdrant similarity if client is available
    if (qdrant) {
      try {
        similarity = await getSimilarity(qdrant, orgId, newDecision.id, candidate.id);
        qdrantAvailable = true;
      } catch {
        // Qdrant unavailable — proceed with Tier 1 only
      }
    }

    // Decision: flag if (Qdrant available AND similarity > threshold) OR
    // (Qdrant unavailable AND area overlap exists)
    const shouldFlag = qdrantAvailable
      ? similarity > SIMILARITY_THRESHOLD
      : true; // area overlap alone is sufficient when Qdrant is unavailable

    if (!shouldFlag) continue;

    // Enforce ordered pair: smaller UUID as decision_a_id per data-model.md
    const [decisionAId, decisionBId] =
      newDecision.id < candidate.id
        ? [newDecision.id, candidate.id]
        : [candidate.id, newDecision.id];

    // Check if this contradiction pair already exists
    try {
      const { data: existing } = await supabase
        .from('contradictions')
        .select('id')
        .eq('decision_a_id', decisionAId)
        .eq('decision_b_id', decisionBId)
        .eq('status', 'open')
        .maybeSingle();

      if (existing) {
        // Already tracked — still include in warnings for the store response
        warnings.push({
          decision_id: candidate.id,
          summary: candidate.summary || candidate.detail.substring(0, 80),
          author: candidate.author,
          overlap_areas: overlapAreas,
          similarity,
        });
        continue;
      }
    } catch {
      // If check fails, attempt insert anyway (unique constraint will catch dupes)
    }

    // INSERT into contradictions table — T026: include project_id
    try {
      const contradictionRecord: Record<string, unknown> = {
        org_id: orgId,
        decision_a_id: decisionAId,
        decision_b_id: decisionBId,
        overlap_areas: overlapAreas,
        similarity_score: qdrantAvailable ? similarity : null,
        status: 'open',
      };
      if (projectId) {
        contradictionRecord.project_id = projectId;
      }
      await supabase.from('contradictions').insert(contradictionRecord);
    } catch {
      // Unique constraint violation or other failure — non-fatal
    }

    warnings.push({
      decision_id: candidate.id,
      summary: candidate.summary || candidate.detail.substring(0, 80),
      author: candidate.author,
      overlap_areas: overlapAreas,
      similarity,
    });
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
