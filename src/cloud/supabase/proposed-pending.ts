/**
 * 040/#226 — truncation-proof COUNT + per-type breakdown + ≤3 preview of the
 * unreviewed draft backlog for ONE project.
 *
 * The draft predicate is `status = 'proposed' OR type = 'pending'` — the same
 * legacy normalization the rest of the codebase applies (`type === 'pending'`
 * rows are treated as proposed decisions). Legacy `pending` rows roll into the
 * `decision` bucket of `by_type`.
 *
 * CRITICAL (lesson `104083be`): the total `count` and every `by_type` count come
 * from a server-side exact COUNT (`select('id', { count: 'exact', head: true })`).
 * A `.length` over a fetched `select()` result silently undercounts once the
 * project exceeds PostgREST's `db-max-rows` ceiling. The `top_3` preview is a
 * bounded `.limit(3)` fetch, so its `.length` is safe by construction.
 *
 * Best-effort by contract (Constitution III): ANY error → returns `null` so the
 * caller OMITS the block rather than fabricating a zero (FR-006/FR-007).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { ProposedPending } from '../../types.js';

/** PostgREST `.or()` predicate matching the legacy draft normalization. */
const DRAFT_OR_PREDICATE = 'status.eq.proposed,type.eq.pending';

/** The four canonical buckets `by_type` must partition `count` into. */
const TYPE_BUCKETS = ['decision', 'pattern', 'lesson', 'constraint'] as const;
type TypeBucket = (typeof TYPE_BUCKETS)[number];

export interface CountProposedScope {
  orgId: string;
  projectId: string;
}

export interface CountProposedOpts {
  /** Preview ordering. Default `created_asc` (oldest-first — surfaces stalest drafts). */
  ranking?: 'created_asc' | 'created_desc';
  /**
   * Dashboard origin used to build `triage_url`. When omitted/empty, `triage_url`
   * is `null` (CLI-stdio direct mode with no resolvable dashboard origin — FR-005).
   */
  origin?: string | null;
  /**
   * Optional similarity lookup keyed by decision id. When a previewed draft id is
   * present here, its score is attached; otherwise `similarity` is `null`. No new
   * embedding round-trip is ever made for the preview (FR-010).
   */
  similarityById?: Map<string, number>;
}

/** Build the triage deep-link, or `null` when no origin is resolvable (FR-005). */
export function buildTriageUrl(origin: string | null | undefined, projectId: string): string | null {
  if (!origin) return null;
  const base = origin.replace(/\/$/, '');
  return `${base}/projects/${projectId}/decisions/triage`;
}

/**
 * Run a single truncation-proof exact COUNT for the draft predicate, optionally
 * narrowed to one `type`. Returns the count or throws (callers wrap in try/catch).
 */
async function exactCount(
  client: SupabaseClient,
  scope: CountProposedScope,
  type?: TypeBucket,
): Promise<number> {
  let q = client
    .from('decisions')
    .select('id', { count: 'exact', head: true })
    .eq('org_id', scope.orgId)
    .eq('project_id', scope.projectId)
    .or(DRAFT_OR_PREDICATE);
  if (type === 'decision') {
    // Legacy `type='pending'` rows normalize into the `decision` bucket, so the
    // decision bucket = drafts whose type is decision OR pending.
    q = q.in('type', ['decision', 'pending']);
  } else if (type) {
    q = q.eq('type', type);
  }
  const { count, error } = await q;
  if (error) throw new Error(error.message);
  return count ?? 0;
}

/**
 * Compute the `proposed_pending` block for one project. Returns `null` on ANY
 * error so the caller omits the block (never zero-fills — FR-006/FR-007).
 */
export async function countProposedPending(
  client: SupabaseClient,
  scope: CountProposedScope,
  opts: CountProposedOpts = {},
): Promise<ProposedPending | null> {
  try {
    // Per-type counts — four truncation-proof head COUNTs (FR-002/FR-003).
    // finding #3 — the total is DERIVED as their sum rather than a 5th
    // independent COUNT. The four buckets PARTITION the draft predicate
    // exactly (the `decision` bucket absorbs legacy `type='pending'` rows via
    // its `.in('type', ['decision','pending'])` filter, and every draft row has
    // exactly one of the four types), so `sum(buckets) === total` by
    // construction — and each bucket is still a server-side exact head COUNT,
    // so no PostgREST `db-max-rows` truncation can creep in (lesson 104083be).
    const [decision, pattern, lesson, constraint] = await Promise.all([
      exactCount(client, scope, 'decision'),
      exactCount(client, scope, 'pattern'),
      exactCount(client, scope, 'lesson'),
      exactCount(client, scope, 'constraint'),
    ]);
    const count = decision + pattern + lesson + constraint;

    // top_3 — bounded fetch (≤3 rows), so `.length` here is safe (FR-004).
    // finding #3 — gate the preview SELECT on count > 0: on a healthy project
    // with an empty draft backlog the query is guaranteed to return nothing, so
    // skip the round-trip entirely on the hot path.
    let top_3: ProposedPending['top_3'] = [];
    if (count > 0) {
      const ranking = opts.ranking ?? 'created_asc';
      const ascending = ranking !== 'created_desc';
      const { data: previewRows, error: previewErr } = await client
        .from('decisions')
        .select('id, type, summary')
        .eq('org_id', scope.orgId)
        .eq('project_id', scope.projectId)
        .or(DRAFT_OR_PREDICATE)
        .order('created_at', { ascending })
        .limit(3);
      if (previewErr) throw new Error(previewErr.message);

      top_3 = (previewRows ?? []).map(
        (r: { id: string; type: string | null; summary: string | null }) => ({
          id: r.id,
          // finding #1 — mirror the by_type partition: a legacy `type='pending'`
          // draft is counted in the `decision` bucket, so its top_3 label MUST
          // read `decision` too (else the label disagrees with the count it
          // belongs to). Same normalization as context.ts:310/474.
          type: (r.type === 'pending' ? 'decision' : r.type) ?? 'decision',
          summary: r.summary ?? '',
          similarity: opts.similarityById?.get(r.id) ?? null,
        }),
      );
    }

    return {
      count,
      by_type: { decision, pattern, lesson, constraint },
      top_3,
      triage_url: buildTriageUrl(opts.origin, scope.projectId),
    };
  } catch (err) {
    // Best-effort: never block or fail the parent search/context (Constitution III).
    console.error(
      `[proposed-pending] count failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}
