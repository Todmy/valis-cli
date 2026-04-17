import { loadConfig } from '../../config/store.js';
import { getSupabaseClient, listMemberProjects } from '../../cloud/supabase.js';
import type { ServerConfig, ValisConfig } from '../../types.js';

interface ListProjectsResponse {
  projects: Array<{
    id: string;
    name: string;
    role: string;
    decision_count: number;
  }>;
  error?: string;
}

/**
 * List every project the authenticated member has access to.
 *
 * Thin MCP wrapper around the existing `listMemberProjects` helper — exists
 * so that slash commands such as `/valis:init` can enumerate projects through
 * an authenticated MCP channel instead of an anonymous `WebFetch` of
 * `/api/list-projects` (which would fail 401 from the agent's plain HTTP tools).
 *
 * Returns project id, human name, caller's role, and cached decision count
 * when available.
 */
export async function handleListProjects(
  configOverride?: ServerConfig,
): Promise<ListProjectsResponse> {
  try {
    const config = (configOverride ?? (await loadConfig())) as
      | ValisConfig
      | ServerConfig
      | null;
    if (!config) {
      return { projects: [], error: 'not_configured' };
    }

    // Required fields present in both ServerConfig (OAuth/hosted) and
    // ValisConfig (local CLI). Narrow defensively.
    const supabaseUrl = (config as ServerConfig).supabase_url
      ?? (config as ValisConfig).supabase_url;
    const serviceRoleKey = (config as ServerConfig).supabase_service_role_key
      ?? (config as ValisConfig).supabase_service_role_key;
    const memberId = (config as ServerConfig).member_id
      ?? (config as ValisConfig).member_id;

    if (!supabaseUrl || !serviceRoleKey || !memberId) {
      return { projects: [], error: 'missing_credentials' };
    }

    const supabase = getSupabaseClient(supabaseUrl, serviceRoleKey);
    const projects = await listMemberProjects(supabase, memberId);

    return { projects };
  } catch (err) {
    return {
      projects: [],
      error: err instanceof Error ? err.message : 'list_projects_failed',
    };
  }
}
