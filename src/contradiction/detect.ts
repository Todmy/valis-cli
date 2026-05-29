import type { SupabaseClient } from '@supabase/supabase-js';
import type { QdrantClient } from '@qdrant/js-client-rest';
import type {
  Decision,
  Contradiction,
  StoreContradictionWarning,
} from '../types.js';
import { getSimilaritiesForNewDecision } from '../cloud/qdrant.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Minimum cosine similarity to flag a contradiction when Qdrant is available. */
const SIMILARITY_THRESHOLD = 0.75;

/**
 * Tier-1-only (Qdrant unavailable) precision bar. With no vector similarity to
 * discriminate, a single shared `affects` tag is far too weak — a bulk
 * `valis index` of N proposed decisions all tagged e.g. `postgres` would flag
 * every O(N²) pair (issue #71 false-positive explosion). Require either a
 * meaningful absolute overlap (≥2 shared areas) OR a high relative overlap
 * (Jaccard ≥ {@link TIER1_JACCARD_THRESHOLD}) so two narrowly-scoped decisions
 * sharing their only tag still flag, but broad decisions sharing one tag of
 * many do not.
 */
const TIER1_MIN_OVERLAP_AREAS = 2;

/** Jaccard cutoff (intersection/union of affects) for the single-overlap case. */
const TIER1_JACCARD_THRESHOLD = 0.5;

/** Max candidate decisions to fetch + compare on the store hot path. */
const CANDIDATE_FETCH_LIMIT = 200;

/**
 * Decide whether a Tier-1-only (no Qdrant similarity) pair clears the
 * false-positive bar. ≥2 shared areas, or a single shared area that dominates
 * the combined tag set (Jaccard ≥ threshold).
 */
function passesTier1Bar(newAffects: string[], candidateAffects: string[]): boolean {
  const a = new Set(newAffects);
  const b = new Set(candidateAffects);
  let intersection = 0;
  for (const area of a) {
    if (b.has(area)) intersection++;
  }
  if (intersection >= TIER1_MIN_OVERLAP_AREAS) return true;
  if (intersection === 0) return false;
  const union = new Set([...a, ...b]).size;
  const jaccard = union === 0 ? 0 : intersection / union;
  return jaccard >= TIER1_JACCARD_THRESHOLD;
}

// ---------------------------------------------------------------------------
// T021 — Two-tier contradiction detection
// ---------------------------------------------------------------------------

/**
 * Detect potential contradictions between a newly stored decision and existing
 * decisions in the same project. Detection runs for both `active` and
 * `proposed` new decisions — `proposed` is the dominant write path (drafts
 * queue, auto-capture, unprefixed index imports), so gating it off silently
 * broke Constitution Principle IX for the common case (issue #71).
 *
 * **Tier 1 (always)**: Query candidate decisions with status `active` or
 * `proposed` whose `affects` arrays overlap with the new decision via the
 * Postgres `&&` (array overlap) operator. `deprecated`/`superseded` decisions
 * are resolved/retired and excluded by design.
 *
 * **Tier 2 (when Qdrant available)**: For each candidate, compute cosine
 * similarity in Qdrant.  Flag only if similarity > {@link SIMILARITY_THRESHOLD}
 * (0.75).  When Qdrant is unavailable, area overlap alone is sufficient
 * (Tier 1 only).
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

  // NOTE (#71): No status gate on the NEW decision. Detection must run for
  // `proposed` writes (the default path), not only `active` ones.

  // T026: Resolve project_id from the decision — contradictions are scoped within
  // a single project. Cross-project contradictions are not possible by design.
  const projectId = newDecision.project_id || undefined;

  // ------------------------------------------------------------------
  // Tier 1: Find candidates with overlapping affects via SQL &&
  // ------------------------------------------------------------------

  // NOTE (#71): the previous code first tried a `find_contradiction_candidates`
  // RPC that is NOT defined in any migration (migration 004 defines a different
  // `find_contradictions` with an incompatible signature). That RPC always
  // failed, so EVERY store paid a guaranteed-failing round-trip before falling
  // back to this query. There is exactly ONE candidate-status source of truth:
  // a direct `decisions` query filtered to `active`+`proposed`. Do NOT
  // reintroduce a status='active'-only path.
  let candidates: Decision[];
  try {
    let query = supabase
      .from('decisions')
      // Only the columns the detection loop + warnings need — `select('*')`
      // pulled the full row (including large `detail`/embeddings) per candidate.
      .select('id,affects,summary,author,detail')
      .eq('org_id', orgId)
      .in('status', ['active', 'proposed'])
      .neq('id', newDecision.id)
      .overlaps('affects', newDecision.affects)
      .limit(CANDIDATE_FETCH_LIMIT);

    // T026: Scope candidate query to project
    if (projectId) {
      query = query.eq('project_id', projectId);
    }

    const { data, error } = await query;

    if (error) throw error;
    candidates = (data || []) as Decision[];
  } catch {
    // If the candidate query fails, skip contradiction detection
    return warnings;
  }

  if (candidates.length === 0) {
    return warnings;
  }

  // ------------------------------------------------------------------
  // Tier 2: Compute similarity + insert contradictions
  // ------------------------------------------------------------------

  // Batch-retrieve every candidate vector (plus the new decision's vector) in
  // ONE Qdrant round-trip rather than one retrieve per candidate (N+1). An
  // empty map means Qdrant was unavailable / errored → Tier-1-only path.
  let similarityById = new Map<string, number>();
  let qdrantAvailable = false;
  if (qdrant) {
    similarityById = await getSimilaritiesForNewDecision(
      qdrant,
      orgId,
      newDecision.id,
      candidates.map((c) => c.id),
    );
    qdrantAvailable = similarityById.size > 0;
  }

  for (const candidate of candidates) {
    // Compute overlap areas between the two decisions
    const overlapAreas = (newDecision.affects || []).filter((area) =>
      (candidate.affects || []).includes(area),
    );

    if (overlapAreas.length === 0) continue;

    // similarity is the real cosine value when Qdrant is available, else null
    // (mirrors the DB `similarity_score` column — never a misleading 0).
    const similarity: number | null = qdrantAvailable
      ? similarityById.get(candidate.id) ?? 0
      : null;

    // Decision:
    //  - Qdrant available  → flag iff cosine similarity > threshold (0.75).
    //  - Qdrant unavailable → flag iff the affects overlap clears the Tier-1
    //    precision bar (≥2 shared areas or Jaccard ≥ 0.5). A single shared tag
    //    out of many is NOT enough — that path caused the bulk-index
    //    false-positive explosion (#71).
    const shouldFlag = qdrantAvailable
      ? (similarity as number) > SIMILARITY_THRESHOLD
      : passesTier1Bar(newDecision.affects || [], candidate.affects || []);

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
        // `similarity` is already null on the Tier-1-only path, so the
        // in-memory warning, the audit event, and this DB row all agree.
        similarity_score: similarity,
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
