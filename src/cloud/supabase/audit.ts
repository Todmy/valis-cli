/**
 * Supabase audit-trail storage.
 *
 * Owns: audit row insert + org-wide audit-trail retrieval. The
 * per-decision lifecycle history lives next door in decisions.ts because
 * it's coupled to decision lookups; this module owns the generic
 * audit-trail surface.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { AuditEntry } from '../../types.js';

/** Row shape returned by get_lifecycle_history and get_audit_trail RPCs. */
export interface AuditTrailRow {
  id: string;
  org_id: string;
  member_id: string;
  action: string;
  target_type: string;
  target_id: string;
  previous_state: Record<string, unknown> | null;
  new_state: Record<string, unknown> | null;
  reason: string | null;
  created_at: string;
  author_name: string;
  member_role: string;
}

/**
 * Insert an audit entry into the `audit_entries` table.
 */
export async function storeAuditEntry(
  supabase: SupabaseClient,
  entry: Omit<AuditEntry, 'created_at'>,
): Promise<AuditEntry> {
  const { data, error } = await supabase
    .from('audit_entries')
    .insert(entry)
    .select()
    .single();

  if (error) throw new Error(`Failed to store audit entry: ${error.message}`);
  return data as AuditEntry;
}

/**
 * Retrieve the audit trail for an org via the `get_audit_trail` RPC function.
 *
 * Returns audit entries with joined member info, ordered by created_at DESC.
 */
export async function getAuditTrail(
  supabase: SupabaseClient,
  orgId: string,
  limit?: number,
): Promise<AuditTrailRow[]> {
  const { data, error } = await supabase
    .rpc('get_audit_trail', {
      p_org_id: orgId,
      p_limit: limit ?? 50,
    });

  if (error) throw new Error(`Failed to get audit trail: ${error.message}`);
  return (data || []) as AuditTrailRow[];
}
