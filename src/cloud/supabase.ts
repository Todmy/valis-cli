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

  return {
    total_decisions: (stats.total_decisions as number) || 0,
    by_type: (stats.by_type as Record<string, number>) || {},
    by_author: (stats.by_author as Record<string, number>) || {},
    recent: (recent || []) as Decision[],
    pending_count: (stats.pending_count as number) || 0,
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
