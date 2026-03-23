import type { SupabaseClient } from '@supabase/supabase-js';
import type { AuditEntry, AuditAction, AuditTargetType } from '../types.js';

/**
 * Build an audit payload from structured params, ready for insertion.
 */
export function buildAuditPayload(
  action: AuditAction,
  targetType: AuditTargetType,
  targetId: string,
  memberId: string,
  orgId: string,
  opts?: {
    previousState?: Record<string, unknown>;
    newState?: Record<string, unknown>;
    reason?: string;
  },
): Omit<AuditEntry, 'id' | 'created_at'> {
  return {
    org_id: orgId,
    member_id: memberId,
    action,
    target_type: targetType,
    target_id: targetId,
    previous_state: opts?.previousState ?? null,
    new_state: opts?.newState ?? null,
    reason: opts?.reason ?? null,
  };
}

/**
 * Insert an audit entry into the `audit_entries` table.
 *
 * Audit failures are intentionally non-fatal — they log a warning to stderr
 * rather than throwing, so the primary operation is never blocked by audit
 * infrastructure issues.
 */
export async function createAuditEntry(
  supabase: SupabaseClient,
  entry: Omit<AuditEntry, 'id' | 'created_at'>,
): Promise<AuditEntry> {
  const { data, error } = await supabase
    .from('audit_entries')
    .insert(entry)
    .select()
    .single();

  if (error) {
    console.warn(`[teamind] audit write failed: ${error.message}`);
    // Return a synthetic entry so callers always get a value back.
    return {
      id: 'unknown',
      created_at: new Date().toISOString(),
      ...entry,
    } as AuditEntry;
  }

  return data as AuditEntry;
}
