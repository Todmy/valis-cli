/**
 * 039/#94 — MCP scope surface.
 *
 * Shared assembly for the `scope` envelope and `scope_hint` advisory that
 * `valis_search` and `valis_context` attach to every successful response.
 * Keeping this in one module guarantees both transports (stdio direct-Qdrant
 * and hosted-proxy) produce byte-identical envelope shapes.
 *
 * Constitution III: `resolveAccessibleProjects` is best-effort — any failure
 * to enumerate the member's projects degrades to `[active_project]` and never
 * throws or blocks the response (FR-008).
 */

import {
  getSupabaseClient,
  getSupabaseJwtClient,
  getProjectName,
  listMemberProjects,
} from '../../cloud/supabase.js';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { ScopeEnvelope, ServerConfig, ValisConfig } from '../../types.js';

/** A project the member can read, reduced to the envelope shape. */
export interface AccessibleProject {
  id: string;
  name: string;
}

/**
 * Build the `scope` envelope. Pure function, no I/O.
 *
 * `active_project.name` is resolved from the matching `accessibleProjects`
 * entry by id; `null` when no match is available (e.g. the membership lookup
 * failed and `accessibleProjects` only carries a name-less fallback entry).
 *
 * When `activeProjectId` is null/undefined (the `all_projects` path with no
 * single resolvable project scope, finding #2) the whole `active_project`
 * field is `null` — there is no one project to name; `queried_all_projects`
 * carries the meaning instead.
 */
export function buildScopeEnvelope(params: {
  activeProjectId: string | null | undefined;
  accessibleProjects: AccessibleProject[];
  queriedAllProjects: boolean;
}): ScopeEnvelope {
  const { activeProjectId, accessibleProjects, queriedAllProjects } = params;
  const accessible = accessibleProjects.map((p) => ({ id: p.id, name: p.name }));
  if (!activeProjectId) {
    return {
      active_project: null,
      accessible_projects: accessible,
      queried_all_projects: queriedAllProjects,
    };
  }
  const match = accessibleProjects.find((p) => p.id === activeProjectId);
  // Edge case: id resolves but no display name is available (degraded
  // membership lookup). Emit `name: null` rather than an empty string.
  const activeName = match && match.name ? match.name : null;
  return {
    active_project: { id: activeProjectId, name: activeName },
    accessible_projects: accessible,
    queried_all_projects: queriedAllProjects,
  };
}

/**
 * FR-005/FR-006 — compute the optional empty-result advisory.
 *
 * Emits the hint string ONLY when the result set is *genuinely* empty, the
 * member can access more than one project, and the query did not already span
 * all of them (a cross-project retry would otherwise be pointless or
 * redundant). Returns `undefined` in every other case so the field is omitted
 * entirely.
 *
 * "Empty" means BOTH the visible result count AND the suppressed count are
 * zero. A project that HAS matching decisions which all fell below the
 * within-area suppression threshold is NOT empty — concluding "nothing was
 * decided" there would be a lie. Counting `suppressed_count` keeps search.ts
 * and context.ts agreeing on what empty means (finding #3 / FR-005).
 */
export function buildScopeHint(
  resultCount: number,
  accessibleProjectsLength: number,
  queriedAllProjects: boolean,
  suppressedCount = 0,
): string | undefined {
  if (resultCount > 0) return undefined;
  if (suppressedCount > 0) return undefined;
  if (queriedAllProjects) return undefined;
  if (accessibleProjectsLength <= 1) return undefined;
  return (
    'No results in the active project. The member can access ' +
    `${accessibleProjectsLength} projects — retry with \`all_projects: true\` ` +
    'to search across all of them before concluding nothing was decided.'
  );
}

/** Inputs `assembleResponse`/`attachScope` need to build a scope envelope. */
export interface ScopeInputs {
  activeProjectId: string | null;
  accessibleProjects: AccessibleProject[];
  queriedAllProjects: boolean;
}

/**
 * 039/#94 (finding #6) — collapse the repeated
 * `activeProjectId ? { ...resolveAccessibleProjects } : undefined` block that
 * appeared across `handleSearch`, `runMetadataOnlySearch`, and both
 * `handleContext` paths into one helper.
 *
 * Returns `undefined` ONLY on the fail-closed `project_scope_required` path —
 * i.e. no active project AND the query did not span all projects. When
 * `queriedAllProjects` is true with no single resolvable project (finding #2),
 * we STILL emit a scope envelope with `active_project: null` and the
 * accessible-project list, because the type contract promises `scope` on every
 * successful response.
 *
 * `preFetched` threads an already-fetched membership list through so the hot
 * path avoids a second `listMemberProjects` RPC (FR-011, finding #4). An
 * authoritative empty list (`[]`) is honoured; only `undefined` triggers a
 * lookup inside `resolveAccessibleProjects`.
 */
export async function buildScopeInputs(
  config: ValisConfig,
  configOverride: ServerConfig | undefined,
  activeProjectId: string | undefined,
  queriedAllProjects: boolean,
  preFetched?: AccessibleProject[],
): Promise<ScopeInputs | undefined> {
  if (!activeProjectId && !queriedAllProjects) return undefined;

  // all_projects with no single project scope: name no active project, but
  // still enumerate the member's accessible projects (finding #2).
  if (!activeProjectId) {
    return {
      activeProjectId: null,
      accessibleProjects:
        preFetched ?? (await resolveAllAccessibleProjects(config, configOverride)),
      queriedAllProjects,
    };
  }

  return {
    activeProjectId,
    accessibleProjects: await resolveAccessibleProjects(
      config,
      configOverride,
      activeProjectId,
      preFetched,
    ),
    queriedAllProjects,
  };
}

/**
 * FR-008 — best-effort membership enumeration with NO active project to anchor
 * the fallback on (the `all_projects` + no-scope case). Returns `[]` on any
 * failure or missing creds; never throws. Distinct from
 * `resolveAccessibleProjects` which always guarantees at least the active
 * project in its fallback.
 */
export async function resolveAllAccessibleProjects(
  config: ValisConfig,
  configOverride: ServerConfig | undefined,
): Promise<AccessibleProject[]> {
  if (!config.member_id) return [];
  const client = selectMemberSupabaseClient(config, configOverride);
  if (!client) return [];
  try {
    const projects = await listMemberProjects(client.supabase, config.member_id);
    return projects.map((p) => ({ id: p.id, name: p.name }));
  } catch {
    return [];
  }
}

/**
 * Shared JWT-vs-service-role client ladder (finding #6 — was duplicated in
 * scope.ts + context.ts). Prefers a service-role client when the call runs in
 * server mode (`configOverride` present) AND a service-role key is configured;
 * otherwise a JWT client in `jwt` auth mode; otherwise the service-role key if
 * that is all we have. Returns `null` when no usable credentials exist (CLI
 * stdio without a service key).
 *
 * `isServiceRole` lets callers gate cross-org reads (e.g. `getProjectName`
 * for a project outside the caller's memberships) that only a service-role
 * client can perform.
 */
export function selectMemberSupabaseClient(
  config: ValisConfig,
  configOverride: ServerConfig | undefined,
): { supabase: SupabaseClient; isServiceRole: boolean } | null {
  const hasServiceRole = Boolean(configOverride && config.supabase_service_role_key);
  if (hasServiceRole) {
    return {
      supabase: getSupabaseClient(config.supabase_url, config.supabase_service_role_key),
      isServiceRole: true,
    };
  }
  if (config.auth_mode === 'jwt') {
    return {
      supabase: getSupabaseJwtClient(config.supabase_url, config.member_api_key || config.api_key),
      isServiceRole: false,
    };
  }
  if (config.supabase_service_role_key) {
    return {
      supabase: getSupabaseClient(config.supabase_url, config.supabase_service_role_key),
      isServiceRole: true,
    };
  }
  return null;
}

/**
 * T007 / FR-008 / FR-011 — resolve the member's accessible projects,
 * best-effort.
 *
 * Returns `listMemberProjects` mapped to `{ id, name }` when `member_id` plus
 * usable credentials are available; otherwise (CLI stdio mode, missing creds,
 * or any failure) degrades to a single `[{ id: activeProjectId }]` fallback.
 * Never throws.
 *
 * Cross-org targets (feature 033 `target_project_id`) are, by definition, NOT
 * in the caller's memberships — so `listMemberProjects` never carries them and
 * `active_project.name` would resolve `null` (finding #1). To name the queried
 * project per FR-004, when the active id is absent from the membership list we
 * fetch its name directly via `getProjectName` (service-role only) and append
 * it so `buildScopeEnvelope` can match it.
 *
 * When the caller already fetched the membership list (the cross-project path
 * in context.ts does this), pass it via `preFetched` to avoid a second lookup
 * (FR-011). An authoritative EMPTY pre-fetched list is honoured — only
 * `undefined` triggers a lookup here (finding #6).
 */
export async function resolveAccessibleProjects(
  config: ValisConfig,
  configOverride: ServerConfig | undefined,
  activeProjectId: string,
  preFetched?: AccessibleProject[],
): Promise<AccessibleProject[]> {
  // Best-effort name from config when the active project matches the
  // configured scope; empty otherwise (→ active_project.name resolves null
  // unless we can fetch it below).
  const knownName =
    config.project_id === activeProjectId && config.project_name ? config.project_name : '';
  const fallback: AccessibleProject[] = [{ id: activeProjectId, name: knownName }];

  const client = selectMemberSupabaseClient(config, configOverride);

  // Helper: guarantee the active project is named in the returned list.
  // When it's already present we leave it; otherwise (cross-org target) we
  // fetch its name via a service-role lookup so FR-004 holds.
  const ensureActiveNamed = async (
    projects: AccessibleProject[],
  ): Promise<AccessibleProject[]> => {
    if (projects.some((p) => p.id === activeProjectId)) return projects;
    let name = knownName;
    if (!name && client?.isServiceRole) {
      try {
        name = (await getProjectName(client.supabase, activeProjectId)) ?? '';
      } catch {
        name = '';
      }
    }
    return [...projects, { id: activeProjectId, name }];
  };

  if (preFetched !== undefined) {
    return ensureActiveNamed(preFetched.map((p) => ({ id: p.id, name: p.name })));
  }

  if (!config.member_id) return ensureActiveNamed([]);

  try {
    if (!client) return ensureActiveNamed([]);

    const projects = await listMemberProjects(client.supabase, config.member_id);
    return ensureActiveNamed(projects.map((p) => ({ id: p.id, name: p.name })));
  } catch {
    // FR-008 / Constitution III — never block the response on a membership
    // enumeration failure. Degrade to the active project only.
    return fallback;
  }
}
