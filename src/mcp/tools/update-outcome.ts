/**
 * 028-phase13-data-model (Track 5a) — `valis_update_outcome` MCP tool handler.
 *
 * Records the team's after-the-fact verdict on a stored decision. Single-shot
 * write: normalise the caller's outcome string, validate the decision exists
 * in the caller's org, update the row, append one audit_entries row. Returns
 * the updated outcome triple plus prior values so the caller (and any agent
 * trace) can compare verdict deltas.
 *
 * The typo-tolerant lookup is the load-bearing piece: agent call-sites are
 * LLM-generated text where surface forms vary (`SUCCEEDED`, `OK`, `FAIL`,
 * `BROKE`). A strict-enum rejection forces the model into retry loops, so
 * we accept everything we can confidently map to the four canonical values
 * and reject the rest with a structured error that lists the allowed set.
 *
 * Non-blocking does NOT apply here: this is a deliberate write call, not a
 * post-write side effect. Authorisation failure and unknown decision_id
 * surface as structured errors that the agent can act on.
 */

import { loadConfig } from '../../config/store.js';
import {
  getSupabaseClient,
  getSupabaseJwtClient,
  getDecisionById,
} from '../../cloud/supabase.js';
import { getQdrantClient } from '../../cloud/qdrant.js';
import { setDecisionPayload } from '../../cloud/qdrant/decisions.js';
import { buildAuditPayload, createAuditEntry } from '../../auth/audit.js';
import { canWriteToProject } from '../../lib/project-access.js';
import type { ServerConfig } from '../../types.js';

// ---------------------------------------------------------------------------
// Outcome taxonomy
// ---------------------------------------------------------------------------

export type OutcomeStatus = 'success' | 'failed' | 'partial' | 'unknown';

export const CANONICAL_OUTCOMES: readonly OutcomeStatus[] = [
  'success',
  'failed',
  'partial',
  'unknown',
] as const;

/**
 * Surface-form → canonical lookup. Modelled on MAMA's `update-outcome.js`
 * (lines 25-58). Case-insensitive at lookup time so callers don't have to
 * normalise themselves. Whitespace tolerance and underscore/hyphen handling
 * applied by `normaliseOutcome` below.
 */
const OUTCOME_ALIASES: Record<string, OutcomeStatus> = {
  // success family
  success: 'success',
  succeeded: 'success',
  succeed: 'success',
  ok: 'success',
  done: 'success',
  shipped: 'success',
  worked: 'success',

  // failed family
  failed: 'failed',
  fail: 'failed',
  failure: 'failed',
  broke: 'failed',
  broken: 'failed',
  regressed: 'failed',
  regression: 'failed',

  // partial family
  partial: 'partial',
  'partial-success': 'partial',
  partialsuccess: 'partial',
  mixed: 'partial',

  // unknown family
  unknown: 'unknown',
  tbd: 'unknown',
  wip: 'unknown',
  pending: 'unknown',
};

/**
 * Normalise a free-form outcome string to its canonical value. Returns
 * `null` when the input can't be confidently mapped — callers surface a
 * structured error in that case (FR-009).
 */
export function normaliseOutcome(raw: string): OutcomeStatus | null {
  if (typeof raw !== 'string') return null;
  const cleaned = raw.trim().toLowerCase().replace(/[_\s]+/g, '-');
  if (cleaned.length === 0) return null;
  // Try the cleaned form, then a hyphen-stripped variant — `partial_success`
  // becomes `partial-success` after replace; `partial success` likewise.
  if (cleaned in OUTCOME_ALIASES) return OUTCOME_ALIASES[cleaned];
  const stripped = cleaned.replace(/-/g, '');
  if (stripped in OUTCOME_ALIASES) return OUTCOME_ALIASES[stripped];
  return null;
}

// ---------------------------------------------------------------------------
// Public handler
// ---------------------------------------------------------------------------

export interface UpdateOutcomeArgs {
  decision_id: string;
  outcome: string;
  reason?: string;
  /**
   * Project UUID the decision belongs to. Required in plugin/OAuth mode when
   * the decision was stored cross-org (issue #54): without it, the lookup
   * filters by the auth-resolved `org_id` and may return `decision_not_found`
   * even when the decision exists in a project the caller has access to.
   */
  project_id?: string;
}

export interface UpdateOutcomeResponse {
  decision_id: string;
  previous_outcome: OutcomeStatus;
  outcome: OutcomeStatus;
  outcome_reason: string | null;
  outcome_updated_at: string;
}

export interface UpdateOutcomeError {
  error:
    | 'invalid_outcome'
    | 'decision_not_found'
    | 'not_configured'
    | 'unauthorized'
    | 'project_access_denied'
    | 'write_failed';
  message: string;
  /** Canonical values list — present only when error === 'invalid_outcome'. */
  allowed?: readonly OutcomeStatus[];
}

export async function handleUpdateOutcome(
  args: UpdateOutcomeArgs,
  configOverride?: ServerConfig,
): Promise<UpdateOutcomeResponse | UpdateOutcomeError> {
  const config = configOverride ?? (await loadConfig());
  if (!config) {
    return {
      error: 'not_configured',
      message: 'Valis not configured. Run `valis init` first.',
    };
  }

  // Normalise BEFORE any DB call — bad input never costs a round-trip.
  const canonical = normaliseOutcome(args.outcome);
  if (!canonical) {
    return {
      error: 'invalid_outcome',
      message: `Unknown outcome '${args.outcome}'. Use one of: ${CANONICAL_OUTCOMES.join(', ')}.`,
      allowed: CANONICAL_OUTCOMES,
    };
  }

  // Issue #54 (hotfix on top of initial fix): when `project_id` is provided,
  // BOTH the membership precheck AND the subsequent decision lookup must run
  // through the service-role client, not the JWT client. RLS on
  // `project_members` and `decisions` is gated by the JWT-resolved org; for
  // cross-org rows (the entire point of the project_id path) the JWT client
  // returns zero rows on legitimate access, producing a misleading
  // `project_access_denied` even when membership is real.
  //
  // Mirror of the pattern already used in lifecycle.ts: explicit service-role
  // when project_id is given, with the membership precheck closing the
  // service-role-bypass hole.
  let supabase =
    config.auth_mode === 'jwt'
      ? getSupabaseJwtClient(config.supabase_url, config.member_api_key || config.api_key)
      : getSupabaseClient(config.supabase_url, config.supabase_service_role_key);

  if (args.project_id) {
    if (!config.supabase_service_role_key) {
      return {
        error: 'write_failed',
        message:
          'project_id parameter requires service-role access, which is unavailable in CLI stdio mode. ' +
          'Remove project_id and rely on the auth-resolved org, or switch to the plugin/OAuth path.',
      };
    }
    if (config.member_id) {
      const allowed = await canWriteToProject(
        getSupabaseClient(config.supabase_url, config.supabase_service_role_key),
        config.member_id,
        args.project_id,
      );
      if (!allowed) {
        return {
          error: 'project_access_denied',
          message: `Not a member of project ${args.project_id}.`,
        };
      }
    }
    supabase = getSupabaseClient(config.supabase_url, config.supabase_service_role_key);
  }

  // Existence check. When `project_id` is given, the helper filters by
  // (id, project_id) — cross-org rows become findable. Otherwise the
  // legacy (id, org_id) filter applies and a cross-org id still falls
  // through to 'decision_not_found'.
  let priorRow: { id: string; outcome: OutcomeStatus | null; project_id: string | null } | null = null;
  try {
    const fetched = await getDecisionById(
      supabase,
      config.org_id,
      args.decision_id,
      args.project_id ?? null,
    );
    if (fetched) {
      priorRow = {
        id: fetched.id,
        outcome: (fetched as { outcome?: OutcomeStatus | null }).outcome ?? null,
        project_id: (fetched as { project_id?: string | null }).project_id ?? null,
      };
    }
  } catch (err) {
    return {
      error: 'write_failed',
      message: `Decision lookup failed: ${(err as Error).message}`,
    };
  }

  if (!priorRow) {
    return {
      error: 'decision_not_found',
      message: args.project_id
        ? `No decision with id ${args.decision_id} in project ${args.project_id}.`
        : `No decision with id ${args.decision_id} in this org.`,
    };
  }

  const previousOutcome: OutcomeStatus = priorRow.outcome ?? 'unknown';
  const now = new Date().toISOString();
  const trimmedReason = args.reason?.trim();
  const reasonForWrite = trimmedReason && trimmedReason.length > 0 ? trimmedReason : null;

  // Single UPDATE — atomic per-row. RLS / service-role policy on the supabase
  // client determines whether the write is authorised; a forbidden write
  // surfaces as a Postgres error which we map to `unauthorized`.
  //
  // Issue #54: when `project_id` is given, scope the WHERE by it instead of
  // the auth-resolved `org_id`. The membership precheck above gates the call;
  // without scoping here, a cross-org row would not match `org_id` and the
  // UPDATE would silently affect zero rows.
  let updateQuery = supabase
    .from('decisions')
    .update({
      outcome: canonical,
      outcome_reason: reasonForWrite,
      outcome_updated_at: now,
    })
    .eq('id', args.decision_id);
  updateQuery = args.project_id
    ? updateQuery.eq('project_id', args.project_id)
    : updateQuery.eq('org_id', config.org_id);
  const { error: updateError } = await updateQuery;

  if (updateError) {
    const message = updateError.message ?? String(updateError);
    if (/permission|policy|forbidden/i.test(message)) {
      return {
        error: 'unauthorized',
        message: `Not authorised to update outcome on decision ${args.decision_id}.`,
      };
    }
    return {
      error: 'write_failed',
      message: `Outcome update failed: ${message}`,
    };
  }

  // Audit entry — best-effort, never block the response on a logging failure.
  try {
    const auditPayload = buildAuditPayload(
      'outcome_updated',
      'decision',
      args.decision_id,
      config.member_id || 'unknown',
      config.org_id,
      {
        projectId: priorRow.project_id,
        previousState: { outcome: previousOutcome },
        newState: { outcome: canonical },
        reason: reasonForWrite ?? undefined,
      },
    );
    await createAuditEntry(supabase, auditPayload);
  } catch {
    // Observability gap, not a write-path failure (mirrors lifecycle.ts pattern).
  }

  // Qdrant payload sync — keeps search-time rerank multiplier in step with the
  // new outcome. Best-effort: an outage here leaves Postgres canonical and
  // search slightly stale (max one re-index window), never blocks the response.
  try {
    if (config.qdrant_url && config.qdrant_api_key) {
      const qdrant = getQdrantClient(config.qdrant_url, config.qdrant_api_key);
      await setDecisionPayload(qdrant, args.decision_id, {
        outcome: canonical,
      });
    }
  } catch {
    /* search-side staleness only — Postgres is canonical */
  }

  return {
    decision_id: args.decision_id,
    previous_outcome: previousOutcome,
    outcome: canonical,
    outcome_reason: reasonForWrite,
    outcome_updated_at: now,
  };
}
