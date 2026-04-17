import { loadConfig } from '../../config/store.js';
import { getSupabaseClient } from '../../cloud/supabase.js';
import type { ServerConfig, ValisConfig } from '../../types.js';

interface CreateProjectArgs {
  project_name: string;
  /** Optional org_id. Defaults to the authenticated member's org. */
  org_id?: string;
}

interface CreateProjectResponse {
  project_id: string;
  project_name: string;
  role: string;
  invite_code?: string;
  error?: string;
}

/**
 * Generate a human-friendly invite code in format XXXX-XXXX.
 * Uses 32-char alphabet without ambiguous symbols (no 0/O, 1/I/L).
 * Matches the format produced by `packages/web/src/lib/api-keys.ts` so
 * invite codes generated via MCP are indistinguishable from route-generated ones.
 */
function generateInviteCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const part = (len: number) =>
    Array.from(crypto.getRandomValues(new Uint8Array(len)))
      .map((b) => chars[b % chars.length])
      .join('');
  return `${part(4)}-${part(4)}`;
}

/**
 * Create a new project within the authenticated member's org and register
 * the member as `project_admin`.
 *
 * Written as a companion to `valis_list_projects` so slash commands such as
 * `/valis:init` can offer "create new project" without leaving the session.
 *
 * Note: this path uses the service-role supabase client and bypasses the
 * plan-limit enforcement that lives in `/api/create-project` route. For 017
 * MVP this is acceptable; 019 should extract a shared `createProjectCore`
 * used by both the route and this handler. See BACKLOG for tracking.
 */
export async function handleCreateProject(
  args: CreateProjectArgs,
  configOverride?: ServerConfig,
): Promise<CreateProjectResponse> {
  try {
    const config = (configOverride ?? (await loadConfig())) as
      | ServerConfig
      | ValisConfig
      | null;
    if (!config) {
      return { project_id: '', project_name: '', role: '', error: 'not_configured' };
    }

    const supabaseUrl = (config as ServerConfig).supabase_url
      ?? (config as ValisConfig).supabase_url;
    const serviceRoleKey = (config as ServerConfig).supabase_service_role_key
      ?? (config as ValisConfig).supabase_service_role_key;
    const memberId = (config as ServerConfig).member_id
      ?? (config as ValisConfig).member_id;
    const orgId = args.org_id
      || (config as ServerConfig).org_id
      || (config as ValisConfig).org_id;

    if (!supabaseUrl || !serviceRoleKey || !memberId || !orgId) {
      return { project_id: '', project_name: '', role: '', error: 'missing_credentials' };
    }

    const projectName = args.project_name.trim();
    if (projectName.length === 0) {
      return { project_id: '', project_name: '', role: '', error: 'project_name_required' };
    }
    if (projectName.length > 100) {
      return { project_id: '', project_name: '', role: '', error: 'project_name_too_long' };
    }

    const supabase = getSupabaseClient(supabaseUrl, serviceRoleKey);
    const inviteCode = generateInviteCode();

    // 1. Create the project row. `invite_code` is NOT NULL in schema;
    // omitting it triggers a constraint violation (discovered 2026-04-16).
    const { data: project, error: projectError } = await supabase
      .from('projects')
      .insert({ org_id: orgId, name: projectName, invite_code: inviteCode })
      .select('id, name, invite_code')
      .single();

    if (projectError || !project) {
      return {
        project_id: '',
        project_name: '',
        role: '',
        error: projectError?.message || 'project_insert_failed',
      };
    }

    // 2. Add caller as project_admin
    const { error: memberError } = await supabase
      .from('project_members')
      .insert({
        project_id: project.id,
        member_id: memberId,
        role: 'project_admin',
      });

    if (memberError) {
      // Roll back the orphan project row so we don't leak state on failure.
      await supabase.from('projects').delete().eq('id', project.id);
      return {
        project_id: '',
        project_name: '',
        role: '',
        error: memberError.message,
      };
    }

    return {
      project_id: project.id,
      project_name: project.name,
      role: 'project_admin',
      invite_code: project.invite_code,
    };
  } catch (err) {
    return {
      project_id: '',
      project_name: '',
      role: '',
      error: err instanceof Error ? err.message : 'create_project_failed',
    };
  }
}
