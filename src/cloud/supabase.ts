import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import type {
  AuditEntry,
  Contradiction,
  Decision,
  DecisionStatus,
  RawDecision,
  DecisionSource,
  DashboardStats,
  DependencyWarning,
} from '../types.js';
import { contentHash } from '../capture/dedup.js';
import { getAccessTokenFn } from '../auth/jwt.js';

let client: SupabaseClient | null = null;

export function getSupabaseClient(url: string, serviceRoleKey: string): SupabaseClient {
  if (!client) {
    client = createClient(url, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return client;
}

export function resetClient(): void {
  client = null;
}

// ---------------------------------------------------------------------------
// JWT-authenticated client (Phase 2)
// ---------------------------------------------------------------------------

let jwtClient: SupabaseClient | null = null;

/**
 * Create a Supabase client that authenticates via JWT tokens obtained from
 * the exchange-token Edge Function.
 *
 * Uses the `accessToken` callback pattern described in research.md —
 * each request gets a fresh (or cached) JWT transparently.
 *
 * Keep separate from `getSupabaseClient` to avoid breaking legacy
 * service_role callers.
 */
export function getSupabaseJwtClient(
  url: string,
  apiKey: string,
): SupabaseClient {
  if (!jwtClient) {
    // The anonKey parameter is unused when accessToken callback is set —
    // every request gets its auth from the JWT returned by exchange-token.
    // Pass the URL as a placeholder anonKey to satisfy the createClient signature.
    jwtClient = createClient(url, url, {
      accessToken: getAccessTokenFn(url, apiKey),
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return jwtClient;
}

export function resetJwtClient(): void {
  jwtClient = null;
}

async function setOrgContext(supabase: SupabaseClient, orgId: string): Promise<void> {
  try {
    await supabase.rpc('set_config', {
      setting: 'app.org_id',
      value: orgId,
    });
  } catch {
    // set_config may not exist yet — RLS still works via explicit org_id filter
  }
}

/** Optional extended fields for Phase 2 store. */
export interface StoreExtras {
  status?: 'active' | 'proposed';
  replaces?: string;
  depends_on?: string[];
}

/**
 * Fetch a single decision by ID, scoped to an org.
 * Returns `null` when not found.
 */
export async function getDecisionById(
  supabase: SupabaseClient,
  orgId: string,
  decisionId: string,
): Promise<Decision | null> {
  await setOrgContext(supabase, orgId);
  const { data, error } = await supabase
    .from('decisions')
    .select('*')
    .eq('org_id', orgId)
    .eq('id', decisionId)
    .single();

  if (error || !data) return null;
  return data as Decision;
}

/**
 * Fetch multiple decisions by IDs, scoped to an org.
 * Returns only those that exist.
 */
export async function getDecisionsByIds(
  supabase: SupabaseClient,
  orgId: string,
  decisionIds: string[],
): Promise<Decision[]> {
  if (decisionIds.length === 0) return [];
  await setOrgContext(supabase, orgId);
  const { data, error } = await supabase
    .from('decisions')
    .select('*')
    .eq('org_id', orgId)
    .in('id', decisionIds);

  if (error) throw new Error(`Supabase fetch by IDs failed: ${error.message}`);
  return (data || []) as Decision[];
}

export async function storeDecision(
  supabase: SupabaseClient,
  orgId: string,
  raw: RawDecision,
  author: string,
  source: DecisionSource,
  extras?: StoreExtras,
): Promise<Decision> {
  await setOrgContext(supabase, orgId);
  const id = randomUUID();
  const hash = contentHash(raw.text);

  const record: Record<string, unknown> = {
    id,
    org_id: orgId,
    type: raw.type || 'pending',
    summary: raw.summary || null,
    detail: raw.text,
    status: extras?.status || 'active',
    author,
    source,
    project_id: raw.project_id || null,
    session_id: raw.session_id || null,
    content_hash: hash,
    confidence: raw.confidence || null,
    affects: raw.affects || [],
  };

  if (extras?.replaces) {
    record.replaces = extras.replaces;
  }
  if (extras?.depends_on && extras.depends_on.length > 0) {
    record.depends_on = extras.depends_on;
  }

  const { data, error } = await supabase
    .from('decisions')
    .insert(record)
    .select()
    .single();

  if (error) {
    if (error.code === '23505') {
      // Unique constraint on (org_id, content_hash) — duplicate
      const { data: existing } = await supabase
        .from('decisions')
        .select()
        .eq('org_id', orgId)
        .eq('content_hash', hash)
        .single();
      if (existing) return existing as Decision;
    }
    throw new Error(`Supabase store failed: ${error.message}`);
  }

  return data as Decision;
}

/**
 * T020: Search decisions with optional project_id filter.
 * When projectId is provided, passes p_project_id to the RPC.
 * The RPC falls back to org-scoped search if the parameter is null.
 */
export async function searchDecisions(
  supabase: SupabaseClient,
  orgId: string,
  query: string,
  type?: string,
  limit = 10,
  projectId?: string,
): Promise<Decision[]> {
  await setOrgContext(supabase, orgId);
  const { data, error } = await supabase
    .rpc('search_decisions', {
      p_org_id: orgId,
      p_query: query,
      p_type: type || null,
      p_limit: limit,
      p_project_id: projectId || null,
    });

  if (error) throw new Error(`Supabase search failed: ${error.message}`);
  return (data || []) as Decision[];
}

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

export async function healthCheck(supabase: SupabaseClient): Promise<boolean> {
  try {
    const { error } = await supabase.from('orgs').select('id').limit(1);
    return !error;
  } catch {
    return false;
  }
}

export async function batchStore(
  supabase: SupabaseClient,
  orgId: string,
  decisions: Array<{ raw: RawDecision; author: string; source: DecisionSource }>,
): Promise<number> {
  let stored = 0;
  for (const { raw, author, source } of decisions) {
    try {
      await storeDecision(supabase, orgId, raw, author, source);
      stored++;
    } catch {
      // Skip duplicates and errors in batch mode
    }
  }
  return stored;
}

/**
 * T020: Fetch all decisions, optionally scoped to a project.
 */
export async function getAllDecisions(
  supabase: SupabaseClient,
  orgId: string,
  projectId?: string,
): Promise<Decision[]> {
  await setOrgContext(supabase, orgId);
  let query = supabase
    .from('decisions')
    .select('*')
    .eq('org_id', orgId);
  if (projectId) {
    query = query.eq('project_id', projectId);
  }
  const { data, error } = await query.order('created_at', { ascending: false });

  if (error) throw new Error(`Failed to fetch decisions: ${error.message}`);
  return (data || []) as Decision[];
}

// ---------------------------------------------------------------------------
// Proposed decisions (Phase 3 — US1, T014)
// ---------------------------------------------------------------------------

/**
 * T020: Fetch all proposed decisions, optionally scoped to a project.
 * Used by the dashboard to display the "Proposed (N)" section.
 */
export async function getProposedDecisions(
  supabase: SupabaseClient,
  orgId: string,
  projectId?: string,
): Promise<Decision[]> {
  await setOrgContext(supabase, orgId);
  let query = supabase
    .from('decisions')
    .select('*')
    .eq('org_id', orgId)
    .eq('status', 'proposed');
  if (projectId) {
    query = query.eq('project_id', projectId);
  }
  const { data, error } = await query.order('created_at', { ascending: false });

  if (error) throw new Error(`Failed to fetch proposed decisions: ${error.message}`);
  return (data || []) as Decision[];
}

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
// Lifecycle methods (Phase 2)
// ---------------------------------------------------------------------------

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
 * Update a decision's status with attribution metadata.
 *
 * Used by the change-status flow (deprecate, promote, supersede).
 */
export async function changeDecisionStatus(
  supabase: SupabaseClient,
  orgId: string,
  decisionId: string,
  newStatus: DecisionStatus,
  changedBy: string,
  reason?: string,
): Promise<Decision> {
  await setOrgContext(supabase, orgId);

  const { data, error } = await supabase
    .from('decisions')
    .update({
      status: newStatus,
      status_changed_by: changedBy,
      status_changed_at: new Date().toISOString(),
      status_reason: reason ?? null,
    })
    .eq('id', decisionId)
    .eq('org_id', orgId)
    .select()
    .single();

  if (error) throw new Error(`Failed to change decision status: ${error.message}`);
  return data as Decision;
}

/**
 * Retrieve the full lifecycle history for a decision via the
 * `get_lifecycle_history` RPC function.
 *
 * Returns audit entries (with author_name) ordered chronologically (ASC).
 */
export async function getDecisionHistory(
  supabase: SupabaseClient,
  decisionId: string,
): Promise<AuditTrailRow[]> {
  const { data, error } = await supabase
    .rpc('get_lifecycle_history', { p_decision_id: decisionId });

  if (error) throw new Error(`Failed to get decision history: ${error.message}`);
  return (data || []) as AuditTrailRow[];
}

/**
 * Find decisions that depend on a given decision.
 *
 * Uses the Postgres array containment operator: `decisionId = ANY(depends_on)`.
 */
export async function findDependents(
  supabase: SupabaseClient,
  decisionId: string,
): Promise<Decision[]> {
  const { data, error } = await supabase
    .from('decisions')
    .select('*')
    .contains('depends_on', [decisionId]);

  if (error) throw new Error(`Failed to find dependents: ${error.message}`);
  return (data || []) as Decision[];
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
 * T020/T026: Find active decisions with overlapping `affects` areas,
 * optionally scoped to a project.
 *
 * Used by the contradiction detection pipeline (Tier 1 — area overlap).
 * Cross-project contradictions are not possible by design (T026).
 */
export async function findContradictionCandidates(
  supabase: SupabaseClient,
  orgId: string,
  affects: string[],
  projectId?: string,
): Promise<Decision[]> {
  const { data, error } = await supabase
    .rpc('find_contradictions', {
      p_org_id: orgId,
      p_affects: affects,
      p_project_id: projectId || null,
    });

  if (error) throw new Error(`Failed to find contradiction candidates: ${error.message}`);
  return (data || []) as Decision[];
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

/**
 * T020: Retrieve all open contradictions, optionally scoped to a project.
 */
export async function getOpenContradictions(
  supabase: SupabaseClient,
  orgId: string,
  projectId?: string,
): Promise<Contradiction[]> {
  let query = supabase
    .from('contradictions')
    .select('*')
    .eq('org_id', orgId)
    .eq('status', 'open');
  if (projectId) {
    query = query.eq('project_id', projectId);
  }
  const { data, error } = await query.order('detected_at', { ascending: false });

  if (error) throw new Error(`Failed to get open contradictions: ${error.message}`);
  return (data || []) as Contradiction[];
}

// ---------------------------------------------------------------------------
// Project-scoped decision count (Phase 4 — Multi-Project)
// ---------------------------------------------------------------------------

/**
 * Get the count of decisions in a specific project.
 * Used by status command for project-scoped brain count.
 */
export async function getProjectDecisionCount(
  supabase: SupabaseClient,
  orgId: string,
  projectId: string,
): Promise<number> {
  const { count, error } = await supabase
    .from('decisions')
    .select('id', { count: 'exact', head: true })
    .eq('org_id', orgId)
    .eq('project_id', projectId);

  if (error) throw new Error(`Failed to count project decisions: ${error.message}`);
  return count ?? 0;
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

  return (data || []) as ProjectInfo[];
}

/** Response from the create-project Edge Function. */
export interface CreateProjectResponse {
  project_id: string;
  project_name: string;
  invite_code: string;
  role?: string;
  org_id?: string;
}

/**
 * Create a new project within an org by calling the create-project Edge Function.
 */
export async function createProject(
  supabaseUrl: string,
  apiKey: string,
  orgId: string,
  projectName: string,
  serviceRoleKey?: string,
): Promise<CreateProjectResponse> {
  // Try Edge Function first (Supabase Cloud)
  try {
    const response = await fetch(`${supabaseUrl}/functions/v1/create-project`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ org_id: orgId, project_name: projectName }),
    });

    if (response.ok) {
      return response.json() as Promise<CreateProjectResponse>;
    }

    if (response.status !== 404 && response.status !== 502 && response.status !== 503) {
      const error = await response.json().catch(() => ({ error: 'unknown error' }));
      throw new Error(`Failed to create project: ${(error as Record<string, string>).error || 'unknown error'}`);
    }
  } catch (err) {
    if ((err as Error).message.startsWith('Failed to create project:')) throw err;
    // Fall through to direct SQL
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
  const response = await fetch(`${supabaseUrl}/functions/v1/join-project`, {
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
