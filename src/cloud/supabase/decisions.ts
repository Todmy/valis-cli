/**
 * Supabase decision CRUD + queries.
 *
 * Owns: decision row insert/read/update + lifecycle history + dependency
 * lookups + contradiction candidates + project-scoped queries. The audit
 * row writes, dashboard aggregations, and project/member queries sit in
 * sibling modules.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import type {
  Contradiction,
  Decision,
  DecisionStatus,
  RawDecision,
  DecisionSource,
} from '../../types.js';
import { contentHash } from '../../capture/dedup.js';
import { setOrgContext } from './client.js';
import type { AuditTrailRow } from './audit.js';

/** Optional extended fields for Phase 2 store. */
export interface StoreExtras {
  status?: 'active' | 'proposed';
  replaces?: string;
  depends_on?: string[];
}

/**
 * Fetch a single decision by ID.
 *
 * Default scope is `org_id` (legacy contract — every existing call-site).
 * When `projectId` is provided, the filter switches to `(id, project_id)`
 * — required for issue #54 where a decision was written cross-org (the
 * row's `org_id` is the personal/auth-resolved org, but the project lives
 * in a different team org). Project membership MUST be verified by the
 * caller before passing `projectId` here; this helper does not gate it.
 *
 * Returns `null` when not found.
 */
export async function getDecisionById(
  supabase: SupabaseClient,
  orgId: string,
  decisionId: string,
  projectId?: string | null,
): Promise<Decision | null> {
  await setOrgContext(supabase, orgId);
  let query = supabase.from('decisions').select('*').eq('id', decisionId);
  if (projectId) {
    query = query.eq('project_id', projectId);
  } else {
    query = query.eq('org_id', orgId);
  }
  const { data, error } = await query.single();

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

/**
 * Phase 018 (FR-010 / T011a): batch-load violation counters for a set of
 * decision IDs. Used to enrich MCP search/context responses so connected AI
 * assistants can prioritize load-bearing decisions without a reindex of
 * Qdrant payload (see research.md R-013).
 *
 * Returns a map keyed by decision id → {violation_count, last_violated_at}.
 * Missing rows default to {0, null} at the call site. Best-effort: errors
 * short-circuit to an empty map rather than propagate, because the search /
 * context flows must not fail when this optional enrichment fails.
 */
export async function fetchViolationCounters(
  supabase: SupabaseClient,
  decisionIds: string[],
): Promise<Map<string, { violation_count: number; last_violated_at: string | null }>> {
  const map = new Map<
    string,
    { violation_count: number; last_violated_at: string | null }
  >();
  if (decisionIds.length === 0) return map;

  const { data, error } = await supabase
    .from('decisions')
    .select('id, violation_count, last_violated_at')
    .in('id', decisionIds);

  if (error) {
    console.warn(`[018/mcp] fetchViolationCounters failed: ${error.message}`);
    return map;
  }

  for (const row of data ?? []) {
    const r = row as {
      id: string;
      violation_count: number | null;
      last_violated_at: string | null;
    };
    map.set(r.id, {
      violation_count: r.violation_count ?? 0,
      last_violated_at: r.last_violated_at ?? null,
    });
  }
  return map;
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

// ---------------------------------------------------------------------------
// Lifecycle methods (Phase 2)
// ---------------------------------------------------------------------------

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
