/**
 * Stale orphan detection for pending decisions.
 *
 * Orphans are `type='pending'` decisions that have remained unclassified for
 * more than a configurable number of days (default 30).  They are flagged for
 * review — not auto-deprecated — because the enrichment pipeline may not have
 * run yet.
 *
 * @module cleanup/orphans
 */

import type { SupabaseClient } from '@supabase/supabase-js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OrphanCandidate {
  decisionId: string;
  summary: string | null;
  detail: string;
  createdAt: string;
  ageDays: number;
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/**
 * Find pending decisions older than `staleDays` (default 30).
 *
 * Returns an array of `OrphanCandidate` with the computed age in days.
 */
export async function findStaleOrphans(
  supabase: SupabaseClient,
  orgId: string,
  staleDays = 30,
  projectId?: string,
): Promise<OrphanCandidate[]> {
  const cutoff = new Date(Date.now() - staleDays * 86_400_000).toISOString();

  let query = supabase
    .from('decisions')
    .select('id, summary, detail, created_at')
    .eq('org_id', orgId)
    .eq('type', 'pending')
    .lt('created_at', cutoff);
  if (projectId) {
    query = query.eq('project_id', projectId);
  }
  const { data, error } = await query
    .order('created_at', { ascending: true });

  if (error) throw new Error(`Failed to fetch stale orphans: ${error.message}`);
  if (!data || data.length === 0) return [];

  const now = Date.now();
  return data.map((d) => ({
    decisionId: d.id,
    summary: d.summary ?? null,
    detail: d.detail as string,
    createdAt: d.created_at as string,
    ageDays: Math.floor((now - new Date(d.created_at as string).getTime()) / 86_400_000),
  }));
}
