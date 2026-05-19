import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Public-KB access resolver (feature 033).
 *
 * Returns true when the caller may read decisions / contradictions of the
 * target project, i.e. when EITHER the caller is a member of the target
 * project OR the target project has `visibility = 'public'`.
 *
 * The same predicate is enforced at three layers (Postgres RLS, Qdrant
 * server-side gate, MCP tool intent gate); this helper is the single
 * runtime source of truth so the layers cannot drift.
 *
 * Failure is treated as denial: any Supabase error → false. This preserves
 * Constitution Principle III (non-blocking) — a misconfigured database
 * never opens access; it closes it.
 *
 * Precondition: the passed `SupabaseClient` MUST carry service-role auth.
 * The helper queries `project_members` directly; with an anon-key client
 * the RLS policy would silently return 0 rows for real members, causing
 * legitimate access to be denied. All MCP tool handlers obtain the client
 * via `getSupabaseClient(url, service_role_key)` — pass that instance.
 */
export async function canReadProject(
  supabase: SupabaseClient,
  callerMemberId: string,
  targetProjectId: string,
): Promise<boolean> {
  if (!callerMemberId || !targetProjectId) return false;

  const [projectResult, membershipResult] = await Promise.all([
    supabase
      .from('projects')
      .select('id, visibility')
      .eq('id', targetProjectId)
      .maybeSingle(),
    supabase
      .from('project_members')
      .select('project_id', { head: true, count: 'exact' })
      .eq('project_id', targetProjectId)
      .eq('member_id', callerMemberId)
      .limit(1),
  ]);

  if (projectResult.error || !projectResult.data) return false;

  if (projectResult.data.visibility === 'public') return true;

  if (membershipResult.error) return false;
  return (membershipResult.count ?? 0) > 0;
}
