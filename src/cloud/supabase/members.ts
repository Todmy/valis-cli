/**
 * Supabase org / member / project membership.
 *
 * Owns: org info + project listing + create / join project. Decision-side
 * concerns (CRUD, history, dependents) sit in decisions.ts. Connection
 * lifecycle in client.ts.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { HOSTED_SUPABASE_URL } from '../../types.js';
import { resolveApiUrl, resolveApiPath } from '../api-url.js';
import { getSupabaseClient } from './client.js';

export async function getOrgInfo(
  supabase: SupabaseClient,
  orgId: string,
): Promise<{ name: string; member_count: number; decision_count: number } | null> {
  const { data: org } = await supabase
    .from('orgs')
    .select('name, decision_count')
    .eq('id', orgId)
    .single();

  if (!org) return null;

  const { count } = await supabase
    .from('members')
    .select('*', { count: 'exact', head: true })
    .eq('org_id', orgId);

  return {
    name: org.name,
    member_count: count || 0,
    decision_count: org.decision_count,
  };
}

// ---------------------------------------------------------------------------
// Project listing (Phase 4 — Multi-Project)
// ---------------------------------------------------------------------------

/** Minimal project info returned by list_member_projects RPC. */
export interface ProjectInfo {
  id: string;
  name: string;
  role: string;
  decision_count: number;
}

/**
 * List all projects a member has access to via the `list_member_projects` RPC.
 *
 * Falls back to a direct query on `project_members` joined with `projects`
 * if the RPC is not yet deployed.
 */
export async function listMemberProjects(
  supabase: SupabaseClient,
  memberId: string,
): Promise<ProjectInfo[]> {
  // Try RPC first
  const { data, error } = await supabase.rpc('list_member_projects', {
    p_member_id: memberId,
  });

  if (error) {
    // Fallback: direct query if RPC doesn't exist yet
    const { data: fallbackData, error: fallbackError } = await supabase
      .from('project_members')
      .select('project_id, role, projects(id, name)')
      .eq('member_id', memberId);

    if (fallbackError) {
      throw new Error(`Failed to list member projects: ${fallbackError.message}`);
    }

    return (fallbackData || []).map((row: Record<string, unknown>) => {
      const project = row.projects as Record<string, unknown> | null;
      return {
        id: (project?.id as string) ?? (row.project_id as string),
        name: (project?.name as string) ?? 'unknown',
        role: row.role as string,
        decision_count: 0,
      };
    });
  }

  // BUG #144 root cause: the RPC `list_member_projects` returns rows with
  // columns named `project_id`/`project_name`/`project_role` (per migration
  // 004), but `ProjectInfo` declares `id`/`name`/`role`. The previous bare
  // `as ProjectInfo[]` cast was a TypeScript lie — at runtime every row's
  // `.id` was undefined, so callers like `valis_context` produced
  // `match.any: [null, null, ...]` filters that Qdrant 400's. Map
  // explicitly to the public shape.
  return ((data ?? []) as Array<Record<string, unknown>>).map((row) => ({
    id: (row.project_id ?? row.id) as string,
    name: (row.project_name ?? row.name ?? 'unknown') as string,
    role: (row.project_role ?? row.role) as string,
    decision_count: Number(row.decision_count ?? 0),
  }));
}

/**
 * 039/#94 — fetch a single project's display name by id, best-effort.
 *
 * Used by the scope-envelope assembly to name a cross-org `target_project_id`
 * that is, by definition, NOT in the caller's own memberships (so
 * `listMemberProjects` will never carry it). Returns `null` on any failure or
 * when the row is absent — callers degrade to `name: null` and never throw
 * (Constitution III). Requires a service-role client to read across org
 * boundaries (the public-KB cross-org path always holds one).
 */
export async function getProjectName(
  supabase: SupabaseClient,
  projectId: string,
): Promise<string | null> {
  const { data, error } = await supabase
    .from('projects')
    .select('name')
    .eq('id', projectId)
    .maybeSingle();

  if (error || !data) return null;
  return ((data as { name?: string | null }).name as string | null) ?? null;
}

/** Response from the create-project Edge Function. */
export interface CreateProjectResponse {
  project_id: string;
  project_name: string;
  invite_code: string;
  role?: string;
  org_id?: string;
  /** 019/US6: set when the project was seeded from a constitution template. Format: `<id>@v<version>`. */
  template_source?: string | null;
  /** 019/US6: number of decisions seeded from the template (0 when no template). */
  decisions_seeded?: number;
}

/**
 * Create a new project within an org by calling the create-project Edge Function.
 *
 * When `templateId` is provided, the server seeds the chosen constitution
 * template atomically (019/US6). 4xx responses include `error` + `message`
 * fields (and `upsell_url` for plan-gated denials) — the caller is expected
 * to surface those verbatim and exit non-zero.
 */
export async function createProject(
  supabaseUrl: string,
  apiKey: string,
  orgId: string,
  projectName: string,
  serviceRoleKey?: string,
  templateId?: string | null,
  memberId?: string | null,
): Promise<CreateProjectResponse> {
  // Try Edge Function / API route first (Supabase Cloud / Vercel)
  const isHosted = supabaseUrl.replace(/\/$/, '') === HOSTED_SUPABASE_URL;
  const apiBase = resolveApiUrl(supabaseUrl, isHosted);
  const createProjectUrl = resolveApiPath(apiBase, 'create-project');
  try {
    const body: Record<string, unknown> = { org_id: orgId, project_name: projectName };
    if (templateId) body.template_id = templateId;

    const response = await fetch(createProjectUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (response.ok) {
      return response.json() as Promise<CreateProjectResponse>;
    }

    if (response.status !== 404 && response.status !== 502 && response.status !== 503) {
      const errBody = await response.json().catch(() => ({ error: 'unknown error' })) as Record<string, unknown>;
      const message = (errBody.message as string) || (errBody.error as string) || 'unknown error';
      const upsellUrl = errBody.upsell_url as string | undefined;
      const errorCode = errBody.error as string | undefined;
      // 402 plan-gated denials carry an upsell URL; include verbatim.
      // 500 seed_failed signals atomic rollback — instruct retry.
      let suffix = '';
      if (upsellUrl) suffix = ` See ${upsellUrl}`;
      else if (response.status === 500 && errorCode === 'seed_failed') {
        suffix = ' Please retry the same command.';
      }
      throw new Error(`Failed to create project: ${message}${suffix}`);
    }
  } catch (err) {
    if ((err as Error).message.startsWith('Failed to create project:')) throw err;
    // Fall through to direct SQL
  }

  // Templates require the hosted Edge Function path — community-mode direct
  // SQL fallback would bypass plan gates, audit logging, and atomic seeding.
  if (templateId) {
    throw new Error(
      `Failed to create project: Templates require hosted mode (Edge Function unavailable). ` +
      `Re-run without --template to create a blank project, or switch to hosted Valis.`,
    );
  }

  // Direct SQL fallback (community / self-hosted mode)
  if (!serviceRoleKey) {
    throw new Error('Failed to create project: Edge Functions unavailable and no service_role_key for direct SQL');
  }
  const supabase = getSupabaseClient(supabaseUrl, serviceRoleKey);
  const projectId = crypto.randomUUID();
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const inviteCode = [...Array(4)].map(() => chars[Math.floor(Math.random() * chars.length)]).join('')
    + '-' + [...Array(4)].map(() => chars[Math.floor(Math.random() * chars.length)]).join('');

  const { error: projErr } = await supabase.from('projects').insert({
    id: projectId, org_id: orgId, name: projectName, invite_code: inviteCode,
  });
  if (projErr) throw new Error(`Failed to create project: ${projErr.message}`);

  // Link the creator as project_admin — mirrors the hosted create-project Edge
  // Function (supabase/functions/create-project/index.ts step 9). Without this
  // row, MCP `canWriteToProject` denies every store with project_access_denied.
  // Rolls back the project on failure to avoid an orphaned, membership-less row.
  if (memberId) {
    const { error: memberErr } = await supabase.from('project_members').insert({
      project_id: projectId, member_id: memberId, role: 'project_admin',
    });
    if (memberErr) {
      await supabase.from('projects').delete().eq('id', projectId);
      throw new Error(`Failed to create project: ${memberErr.message}`);
    }
  }

  return {
    project_id: projectId,
    project_name: projectName,
    invite_code: inviteCode,
    org_id: orgId,
  };
}

/** Response from the join-project Edge Function. */
export interface JoinProjectResponse {
  org_id: string;
  org_name: string;
  project_id: string;
  project_name: string;
  api_key?: string;
  member_api_key?: string;
  member_id?: string;
  supabase_url?: string;
  qdrant_url?: string;
  member_count?: number;
  decision_count?: number;
  role: string;
}

/**
 * Join an existing project via invite code by calling the join-project Edge Function.
 */
export async function joinProject(
  supabaseUrl: string,
  inviteCode: string,
  authorName: string,
): Promise<JoinProjectResponse> {
  const isHostedJoin = supabaseUrl.replace(/\/$/, '') === HOSTED_SUPABASE_URL;
  const apiBase = resolveApiUrl(supabaseUrl, isHostedJoin);
  const joinProjectUrl = resolveApiPath(apiBase, 'join-project');
  const response = await fetch(joinProjectUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ invite_code: inviteCode, author_name: authorName }),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'unknown error' }));
    throw new Error(`Failed to join project: ${(error as Record<string, string>).error || 'unknown error'}`);
  }

  return response.json() as Promise<JoinProjectResponse>;
}
