/**
 * 031/Track 5b — `valis_evolve` MCP tool handler.
 *
 * Lets an agent declare an explicit typed relationship between two
 * decisions: `supersedes`, `builds_on`, `synthesizes`, or `contradicts`.
 * Inserts one row into `decision_edges` and writes one audit-trail entry.
 *
 * The handler is a primary write path — its failure mode is a structured
 * error the agent can retry, not a silent degradation. Non-blocking
 * (Constitution III) does NOT apply here.
 *
 * Cross-org safety: both decision ids MUST resolve in the caller's org.
 * The error wording is identical for "not found" and "different org" so
 * the response cannot be used as an oracle for cross-org existence.
 */

import { loadConfig } from '../../config/store.js';
import {
  getSupabaseClient,
  getSupabaseJwtClient,
  getDecisionById,
} from '../../cloud/supabase.js';
import { buildAuditPayload, createAuditEntry } from '../../auth/audit.js';
import { canWriteToProject, getServiceRoleSupabase } from '../../lib/project-access.js';
import type { ServerConfig } from '../../types.js';
import type { EdgeType } from '../../cloud/edge-walker.js';

const CANONICAL_EDGE_TYPES: readonly EdgeType[] = [
  'supersedes',
  'builds_on',
  'synthesizes',
  'contradicts',
] as const;

function isCanonicalEdgeType(t: string): t is EdgeType {
  return (CANONICAL_EDGE_TYPES as readonly string[]).includes(t);
}

export interface EvolveArgs {
  from_id: string;
  to_id: string;
  type: string;
  reason?: string;
  /**
   * Project UUID both decisions belong to. Required in plugin/OAuth mode
   * when the decisions were stored cross-org. Sibling fix to PR #55
   * (issue #54) which added the same parameter to update_outcome /
   * lifecycle / store. Without it, the lookup filters by the auth-resolved
   * `org_id` and the cross-org rows return `decision_not_found`.
   */
  project_id?: string;
}

export interface EvolveResponse {
  edge_id: string;
  from_id: string;
  to_id: string;
  type: EdgeType;
  reason: string | null;
  created_at: string;
}

export interface EvolveError {
  error:
    | 'not_configured'
    | 'invalid_type'
    | 'self_reference'
    | 'decision_not_found'
    | 'project_access_denied'
    | 'write_failed';
  message: string;
  allowed?: readonly EdgeType[];
}

export async function handleEvolve(
  args: EvolveArgs,
  configOverride?: ServerConfig,
): Promise<EvolveResponse | EvolveError> {
  const config = configOverride ?? (await loadConfig());
  if (!config) {
    return {
      error: 'not_configured',
      message: 'Valis not configured. Run `valis init` first.',
    };
  }

  // FR-014 / FR-008 input validation — fail before any DB call.
  if (!isCanonicalEdgeType(args.type)) {
    return {
      error: 'invalid_type',
      message: `Unknown edge type '${args.type}'. Use one of: ${CANONICAL_EDGE_TYPES.join(', ')}.`,
      allowed: CANONICAL_EDGE_TYPES,
    };
  }
  if (args.from_id === args.to_id) {
    return {
      error: 'self_reference',
      message: 'from_id and to_id must reference different decisions.',
    };
  }

  // Issue #54 sibling fix: when `project_id` is provided, switch to
  // service-role client + membership precheck and scope decision lookups
  // by `(id, project_id)` instead of `(id, org_id)`. Without this branch,
  // cross-org rows (the entire reason `project_id` is in the schema) would
  // fail with `decision_not_found` even when the caller is a real member.
  // Mirrors the pattern in update-outcome.ts and lifecycle.ts.
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
        getServiceRoleSupabase(config.supabase_url, config.supabase_service_role_key),
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
    supabase = getServiceRoleSupabase(config.supabase_url, config.supabase_service_role_key);
  }

  // FR-007 — both endpoints must resolve in caller's scope. Run both lookups
  // in parallel; either missing → uniform "decision_not_found" error (no
  // information leak between "doesn't exist" and "exists in another org").
  // When project_id is given, the helper filters by (id, project_id);
  // otherwise the legacy (id, org_id) filter applies.
  const [fromRow, toRow] = await Promise.all([
    getDecisionById(supabase, config.org_id, args.from_id, args.project_id ?? null).catch(() => null),
    getDecisionById(supabase, config.org_id, args.to_id, args.project_id ?? null).catch(() => null),
  ]);

  if (!fromRow || !toRow) {
    return {
      error: 'decision_not_found',
      message:
        'One or both decisions could not be resolved in your org. Verify the UUIDs and your project scope.',
    };
  }

  const reasonForWrite = args.reason?.trim();
  const reason = reasonForWrite && reasonForWrite.length > 0 ? reasonForWrite : null;

  // Issue #54 sibling: the edge must land under the same org as the
  // decisions it links. When project_id is given, both fromRow and toRow
  // came from a cross-org lookup — use fromRow.org_id, not config.org_id
  // (which is the auth-resolved personal org for OAuth callers).
  const effectiveOrgId =
    args.project_id && (fromRow as { org_id?: string }).org_id
      ? (fromRow as { org_id: string }).org_id
      : config.org_id;

  const { data: inserted, error: insertError } = await supabase
    .from('decision_edges')
    .insert({
      org_id: effectiveOrgId,
      from_id: args.from_id,
      to_id: args.to_id,
      type: args.type,
      reason,
    })
    .select('id, created_at')
    .single();

  if (insertError || !inserted) {
    return {
      error: 'write_failed',
      message: insertError?.message ?? 'Edge insert failed (no row returned).',
    };
  }

  const insertedRow = inserted as { id: string; created_at: string };

  // FR-009 audit trail — best-effort, never block the response on a
  // logging failure. The pattern mirrors update-outcome.ts and lifecycle.ts.
  try {
    const auditPayload = buildAuditPayload(
      'evolve',
      'decision',
      insertedRow.id,
      config.member_id || 'unknown',
      effectiveOrgId,
      {
        // Scope the lineage audit row to the `from` decision's project — the
        // edge "belongs" to whatever project the originating decision lives in.
        projectId: (fromRow as { project_id?: string | null }).project_id ?? null,
        newState: {
          edge_id: insertedRow.id,
          from_id: args.from_id,
          to_id: args.to_id,
          type: args.type,
          reason,
        },
      },
    );
    await createAuditEntry(supabase, auditPayload);
  } catch {
    /* observability gap — primary write succeeded */
  }

  return {
    edge_id: insertedRow.id,
    from_id: args.from_id,
    to_id: args.to_id,
    type: args.type,
    reason,
    created_at: insertedRow.created_at,
  };
}
