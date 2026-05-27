import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseClient } from '../cloud/supabase.js';

/**
 * Branded `SupabaseClient` type marking a client constructed with the
 * service-role key. The `canWriteToProject` and `resolveProjectOrg` helpers
 * require this brand because they query `project_members` / `projects`
 * directly — with an anon-key / JWT client, RLS would silently return 0
 * rows for cross-org members, causing legitimate access to be denied.
 *
 * The brand is structural-only: at runtime the value is a plain
 * `SupabaseClient`. The cast happens inside `getServiceRoleSupabase` so
 * call sites cannot accidentally fabricate the brand. A non-service-role
 * client passed to a `ServiceRoleClient`-typed parameter fails to compile.
 *
 * Bug origin: PR #56 hotfix on issue #54 — `update-outcome.ts` passed the
 * auth-mode-resolved (JWT in OAuth) client to `canWriteToProject` and
 * returned misleading `project_access_denied` for legitimate cross-org
 * members. The branding prevents that class of regression in future
 * tools that need the same precheck.
 */
declare const SERVICE_ROLE_BRAND: unique symbol;
export type ServiceRoleClient = SupabaseClient & {
  readonly [SERVICE_ROLE_BRAND]: true;
};

/**
 * Construct a `ServiceRoleClient` from URL + service-role key. The single
 * authorised path for callers that need to invoke `canWriteToProject` or
 * `resolveProjectOrg`. Encoding the precondition in the factory makes
 * misuse impossible: there is no other way to obtain the brand.
 */
export function getServiceRoleSupabase(
  url: string,
  serviceRoleKey: string,
): ServiceRoleClient {
  return getSupabaseClient(url, serviceRoleKey) as ServiceRoleClient;
}

/**
 * Escape hatch for callers that obtain a service-role client by other means
 * (e.g. Next.js API routes that get one via a framework-specific factory
 * like `createServerClient` from `@/lib/supabase-server`, which internally
 * uses the service-role key from env).
 *
 * Name is intentionally explicit so any cast site stays grep-able. Do NOT
 * use this to "fix" a compile error on a JWT/anon client — that would
 * reintroduce the BUG #56 class of regression.
 */
export function assertServiceRoleClient(
  client: SupabaseClient,
): ServiceRoleClient {
  return client as ServiceRoleClient;
}

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

/**
 * Write-side access resolver (issue #54).
 *
 * Returns true only when the caller is an actual member of the project.
 * Unlike `canReadProject`, public visibility does NOT grant write access —
 * only members may pin, deprecate, promote, or update outcomes.
 *
 * Used by `valis_update_outcome` and `valis_lifecycle` to gate writes when
 * the caller passes an explicit `project_id` (which bypasses the default
 * `org_id` filter and would otherwise allow cross-org writes via the
 * service-role client).
 */
export async function canWriteToProject(
  supabase: ServiceRoleClient,
  callerMemberId: string,
  targetProjectId: string,
): Promise<boolean> {
  if (!callerMemberId || !targetProjectId) return false;

  const { count, error } = await supabase
    .from('project_members')
    .select('project_id', { head: true, count: 'exact' })
    .eq('project_id', targetProjectId)
    .eq('member_id', callerMemberId)
    .limit(1);

  if (error) return false;
  return (count ?? 0) > 0;
}

/**
 * Resolve a project's target `org_id` and verify caller membership in one
 * pass. Used by `valis_store` to fix #176 at write time: when an OAuth
 * caller writes with an explicit `project_id`, the row must land under the
 * project's org, NOT the caller's auth-resolved (often personal) org.
 *
 * Precondition: pass a service-role client. Without it the project lookup
 * is RLS-gated and may falsely return `project_not_found` for legitimate
 * cross-org members.
 *
 * Returns:
 *   - `{ org_id }` on success
 *   - `{ error: 'project_not_found' }` when the project doesn't exist
 *   - `{ error: 'project_access_denied' }` when the caller is not a member
 */
export async function resolveProjectOrg(
  supabase: ServiceRoleClient,
  callerMemberId: string,
  targetProjectId: string,
): Promise<
  | { org_id: string }
  | { error: 'project_not_found' | 'project_access_denied' }
> {
  if (!callerMemberId || !targetProjectId) {
    return { error: 'project_access_denied' };
  }

  const [projectResult, allowed] = await Promise.all([
    supabase
      .from('projects')
      .select('org_id')
      .eq('id', targetProjectId)
      .maybeSingle(),
    canWriteToProject(supabase, callerMemberId, targetProjectId),
  ]);

  if (projectResult.error || !projectResult.data) {
    return { error: 'project_not_found' };
  }
  if (!allowed) {
    return { error: 'project_access_denied' };
  }

  const orgId = (projectResult.data as { org_id?: string | null }).org_id;
  if (!orgId) {
    // Defensive: every project row should have an org_id (NOT NULL constraint).
    // Treat missing as not-found rather than crashing the write path.
    return { error: 'project_not_found' };
  }
  return { org_id: orgId };
}
