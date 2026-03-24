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
  Subscription,
  UsageOverage,
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
  anonKey: string,
  supabaseUrl: string,
  apiKey: string,
): SupabaseClient {
  if (!jwtClient) {
    jwtClient = createClient(url, anonKey, {
      accessToken: getAccessTokenFn(supabaseUrl, apiKey),
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

export async function searchDecisions(
  supabase: SupabaseClient,
  orgId: string,
  query: string,
  type?: string,
  limit = 10,
): Promise<Decision[]> {
  await setOrgContext(supabase, orgId);
  const { data, error } = await supabase
    .rpc('search_decisions', {
      p_org_id: orgId,
      p_query: query,
      p_type: type || null,
      p_limit: limit,
    });

  if (error) throw new Error(`Supabase search failed: ${error.message}`);
  return (data || []) as Decision[];
}

export async function getDashboardStats(
  supabase: SupabaseClient,
  orgId: string,
): Promise<DashboardStats> {
  await setOrgContext(supabase, orgId);
  const { data, error } = await supabase
    .rpc('get_dashboard_stats', { p_org_id: orgId });

  if (error) throw new Error(`Supabase dashboard failed: ${error.message}`);

  const stats = data as Record<string, unknown>;

  // Get recent 5
  const { data: recent } = await supabase
    .from('decisions')
    .select('*')
    .eq('org_id', orgId)
    .order('created_at', { ascending: false })
    .limit(5);

  // Lifecycle stats: count by status
  const allDecisions = await getAllDecisions(supabase, orgId);
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

  // Pinned count (T045 — US5)
  const pinnedCount = allDecisions.filter((d) => d.pinned === true).length;

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
    pinned_count: pinnedCount,
    dependency_warnings: dependencyWarnings,
  };
}

/**
 * Set or clear the `pinned` flag on a decision.
 *
 * Used by the pin/unpin lifecycle actions. Updates the `pinned` column in
 * Postgres and returns the updated decision row.
 */
export async function pinDecision(
  supabase: SupabaseClient,
  orgId: string,
  decisionId: string,
  pinned: boolean,
): Promise<Decision> {
  await setOrgContext(supabase, orgId);

  const { data, error } = await supabase
    .from('decisions')
    .update({ pinned })
    .eq('id', decisionId)
    .eq('org_id', orgId)
    .select()
    .single();

  if (error) throw new Error(`Failed to ${pinned ? 'pin' : 'unpin'} decision: ${error.message}`);
  return data as Decision;
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

export async function getAllDecisions(
  supabase: SupabaseClient,
  orgId: string,
): Promise<Decision[]> {
  await setOrgContext(supabase, orgId);
  const { data, error } = await supabase
    .from('decisions')
    .select('*')
    .eq('org_id', orgId)
    .order('created_at', { ascending: false });

  if (error) throw new Error(`Failed to fetch decisions: ${error.message}`);
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
 * Find active decisions with overlapping `affects` areas via the
 * `find_contradictions` RPC function.
 *
 * Used by the contradiction detection pipeline (Tier 1 — area overlap).
 */
export async function findContradictionCandidates(
  supabase: SupabaseClient,
  orgId: string,
  affects: string[],
): Promise<Decision[]> {
  const { data, error } = await supabase
    .rpc('find_contradictions', {
      p_org_id: orgId,
      p_affects: affects,
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
 * Retrieve all open contradictions for an org.
 */
export async function getOpenContradictions(
  supabase: SupabaseClient,
  orgId: string,
): Promise<Contradiction[]> {
  const { data, error } = await supabase
    .from('contradictions')
    .select('*')
    .eq('org_id', orgId)
    .eq('status', 'open')
    .order('detected_at', { ascending: false });

  if (error) throw new Error(`Failed to get open contradictions: ${error.message}`);
  return (data || []) as Contradiction[];
}

// ---------------------------------------------------------------------------
// Subscription & Usage queries (Phase 3 — T009)
// ---------------------------------------------------------------------------

/**
 * Fetch the active subscription for an organization.
 * Returns null when no subscription exists (free tier).
 */
export async function getSubscription(
  supabase: SupabaseClient,
  orgId: string,
): Promise<Subscription | null> {
  const { data, error } = await supabase
    .from('subscriptions')
    .select('*')
    .eq('org_id', orgId)
    .in('status', ['active', 'trialing', 'past_due'])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(`Failed to get subscription: ${error.message}`);
  return data as Subscription | null;
}

/**
 * Fetch usage overages for the current billing period.
 * Returns null when no overage record exists.
 */
export async function getCurrentUsageOverage(
  supabase: SupabaseClient,
  orgId: string,
): Promise<UsageOverage | null> {
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from('usage_overages')
    .select('*')
    .eq('org_id', orgId)
    .lte('period_start', now)
    .gte('period_end', now)
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(`Failed to get usage overage: ${error.message}`);
  return data as UsageOverage | null;
}

/**
 * Get the decision count and daily search count for an org.
 * Used for plan limit enforcement (T070).
 */
export async function getUsageCounts(
  supabase: SupabaseClient,
  orgId: string,
): Promise<{ decision_count: number; daily_search_count: number }> {
  // Decision count from orgs table
  const { data: org, error: orgError } = await supabase
    .from('orgs')
    .select('decision_count')
    .eq('id', orgId)
    .single();

  if (orgError) throw new Error(`Failed to get org usage: ${orgError.message}`);

  // Daily search count from audit entries (count today's search actions)
  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);

  const { count, error: searchError } = await supabase
    .from('audit_entries')
    .select('*', { count: 'exact', head: true })
    .eq('org_id', orgId)
    .eq('action', 'decision_stored')
    .gte('created_at', todayStart.toISOString());

  if (searchError) throw new Error(`Failed to get search count: ${searchError.message}`);

  return {
    decision_count: org?.decision_count ?? 0,
    daily_search_count: count ?? 0,
  };
}

/** Usage limit check result. */
export interface UsageLimitCheck {
  allowed: boolean;
  current: number;
  limit: number;
  plan: string;
}

/**
 * Check whether an org has exceeded its usage limit for the current period.
 *
 * Compares the current decision count against the plan's decision limit.
 * Returns `allowed: true` on failure (fail-open guarantee per FR-018).
 *
 * @param supabase  Supabase client.
 * @param orgId  Organization ID.
 * @param planLimits  Map of plan name to max decisions.
 */
export async function checkUsageLimit(
  supabase: SupabaseClient,
  orgId: string,
  planLimits: Record<string, number>,
): Promise<UsageLimitCheck> {
  try {
    const { data: org, error } = await supabase
      .from('orgs')
      .select('plan, decision_count')
      .eq('id', orgId)
      .single();

    if (error || !org) {
      return { allowed: true, current: 0, limit: Infinity, plan: 'unknown' };
    }

    const plan = (org as Record<string, unknown>).plan as string;
    const current = ((org as Record<string, unknown>).decision_count as number) || 0;
    const limit = planLimits[plan] ?? Infinity;

    return {
      allowed: current < limit,
      current,
      limit,
      plan,
    };
  } catch {
    // Fail-open: allow on error
    return { allowed: true, current: 0, limit: Infinity, plan: 'unknown' };
  }
}

/**
 * Count the number of active decisions that reference a given decision
 * in their `depends_on` array (inbound dependency count).
 *
 * Used by the graph connectivity signal when a more accurate count
 * than the within-result-set approximation is needed.
 *
 * @param supabase  Supabase client.
 * @param orgId  Organization ID.
 * @param decisionId  The decision to count dependents for.
 * @returns Number of active decisions that depend on this one.
 */
export async function getDependencyCount(
  supabase: SupabaseClient,
  orgId: string,
  decisionId: string,
): Promise<number> {
  try {
    const { count, error } = await supabase
      .from('decisions')
      .select('*', { count: 'exact', head: true })
      .eq('org_id', orgId)
      .contains('depends_on', [decisionId])
      .in('status', ['active', 'proposed']);

    if (error) return 0;
    return count ?? 0;
  } catch {
    return 0;
  }
}
