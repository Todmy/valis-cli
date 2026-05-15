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

  const supabase =
    config.auth_mode === 'jwt'
      ? getSupabaseJwtClient(config.supabase_url, config.member_api_key || config.api_key)
      : getSupabaseClient(config.supabase_url, config.supabase_service_role_key);

  // FR-007 — both endpoints must resolve in caller's org. Run both lookups
  // in parallel; either missing → uniform "decision_not_found" error (no
  // information leak between "doesn't exist" and "exists in another org").
  const [fromRow, toRow] = await Promise.all([
    getDecisionById(supabase, config.org_id, args.from_id).catch(() => null),
    getDecisionById(supabase, config.org_id, args.to_id).catch(() => null),
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

  const { data: inserted, error: insertError } = await supabase
    .from('decision_edges')
    .insert({
      org_id: config.org_id,
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
      config.org_id,
      {
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
