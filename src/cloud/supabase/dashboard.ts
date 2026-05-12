/**
 * Supabase dashboard aggregations.
 *
 * Owns: the stats RPC + post-processing that combines status counts and
 * dependency warnings into a single `DashboardStats` payload. CRUD lives
 * in decisions.ts.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  Decision,
  DecisionStatus,
  DashboardStats,
  DependencyWarning,
} from '../../types.js';
import { setOrgContext } from './client.js';
import { getAllDecisions } from './decisions.js';

/**
 * T020/T027: Dashboard stats with optional project_id scoping.
 * When projectId is provided, all counts and recent decisions are
 * filtered to that project only.
 */
export async function getDashboardStats(
  supabase: SupabaseClient,
  orgId: string,
  projectId?: string,
): Promise<DashboardStats> {
  await setOrgContext(supabase, orgId);
  const { data, error } = await supabase
    .rpc('get_dashboard_stats', {
      p_org_id: orgId,
      p_project_id: projectId || null,
    });

  if (error) throw new Error(`Supabase dashboard failed: ${error.message}`);

  const stats = data as Record<string, unknown>;

  // Get recent 5 — scoped to project when available
  let recentQuery = supabase
    .from('decisions')
    .select('*')
    .eq('org_id', orgId);
  if (projectId) {
    recentQuery = recentQuery.eq('project_id', projectId);
  }
  const { data: recent } = await recentQuery
    .order('created_at', { ascending: false })
    .limit(5);

  // Lifecycle stats: count by status — scoped to project
  const allDecisions = await getAllDecisions(supabase, orgId, projectId);
  const byStatus: Record<DecisionStatus, number> = {
    active: 0,
    deprecated: 0,
    superseded: 0,
    proposed: 0,
  };
  for (const d of allDecisions) {
    const s = (d.status || 'active') as DecisionStatus;
    if (s in byStatus) {
      byStatus[s]++;
    }
  }

  // Dependency warnings: find decisions whose depends_on includes
  // a deprecated or superseded decision
  const deprecatedIds = new Set(
    allDecisions
      .filter((d) => d.status === 'deprecated' || d.status === 'superseded')
      .map((d) => d.id),
  );

  const dependencyWarnings: DependencyWarning[] = [];
  for (const d of allDecisions) {
    if (!d.depends_on || d.depends_on.length === 0) continue;
    // Only warn about active/proposed decisions depending on deprecated deps
    if (d.status === 'deprecated' || d.status === 'superseded') continue;

    for (const depId of d.depends_on) {
      if (deprecatedIds.has(depId)) {
        const dep = allDecisions.find((x) => x.id === depId);
        dependencyWarnings.push({
          decision_id: d.id,
          decision_summary: d.summary || d.detail.substring(0, 60),
          dependency_id: depId,
          dependency_summary: dep ? (dep.summary || dep.detail.substring(0, 60)) : depId,
          dependency_status: dep?.status || 'deprecated',
        });
      }
    }
  }

  return {
    total_decisions: (stats.total_decisions as number) || 0,
    by_type: (stats.by_type as Record<string, number>) || {},
    by_author: (stats.by_author as Record<string, number>) || {},
    recent: (recent || []) as Decision[],
    pending_count: (stats.pending_count as number) || 0,
    by_status: byStatus,
    dependency_warnings: dependencyWarnings,
  };
}

/** Re-export Decision so dashboard.ts callers can type stats.recent without
 * reaching into types.js — the dashboard module already owns the
 * `DashboardStats` shape. */
export type { Decision };
