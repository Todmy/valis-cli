import { createClient, type SupabaseClient } from '@supabase/supabase-js';

// ---------------------------------------------------------------------------
// COGS constants from unit-economics.md (at 50 orgs baseline)
// ---------------------------------------------------------------------------

/** Supabase Pro $25/mo flat => $0.50/org at 50 orgs */
const SUPABASE_COGS_PER_ORG = 0.50;
/** Qdrant Cloud ~$35/mo => $0.70/org at 50 orgs */
const QDRANT_COGS_PER_ORG = 0.70;
/** Baseline org count for fixed-cost allocation */
const COGS_BASELINE_ORGS = 50;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OrgActivity {
  org_id: string;
  org_name: string;
  last_activity: string | null;
}

export interface ActivationFunnel {
  created: number;
  first_store_within_24h: number;
  weekly_active: number;
}

export interface AtRiskOrg {
  org_id: string;
  org_name: string;
  last_activity: string;
}

export interface PlatformMetrics {
  period: '7d' | '30d';
  generated_at: string;

  // Org counts
  total_orgs: number;
  active_orgs_7d: number;
  active_orgs_30d: number;

  // Per-org averages
  avg_decisions_per_org: number;
  avg_searches_per_org: number;

  // COGS
  estimated_cogs_per_org: number;

  // Activation funnel
  activation: ActivationFunnel;

  // Churn / at-risk
  churned_orgs_30d: number;
  at_risk_orgs: AtRiskOrg[];

  // Active members (distinct authors in period)
  active_members: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function periodToInterval(period: '7d' | '30d'): string {
  return period === '7d' ? '7 days' : '30 days';
}

function daysAgo(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString();
}

// ---------------------------------------------------------------------------
// Core computation
// ---------------------------------------------------------------------------

export async function computeMetrics(
  supabaseUrl: string,
  serviceRoleKey: string,
  period: '7d' | '30d' = '7d',
): Promise<PlatformMetrics> {
  // Use a dedicated client with service_role key — not the singleton.
  const supabase: SupabaseClient = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const now = new Date();
  const cutoff7d = daysAgo(7);
  const cutoff30d = daysAgo(30);
  const periodCutoff = period === '7d' ? cutoff7d : cutoff30d;

  // ------------------------------------------------------------------
  // 1. Total orgs
  // ------------------------------------------------------------------
  const { count: totalOrgs } = await supabase
    .from('orgs')
    .select('*', { count: 'exact', head: true });

  // ------------------------------------------------------------------
  // 2. All orgs with names (for at-risk reporting)
  // ------------------------------------------------------------------
  const { data: allOrgs } = await supabase
    .from('orgs')
    .select('id, name, created_at');

  const orgMap = new Map<string, { name: string; created_at: string }>();
  for (const o of allOrgs || []) {
    orgMap.set(o.id, { name: o.name, created_at: o.created_at });
  }

  // ------------------------------------------------------------------
  // 3. Active orgs — orgs with at least one decision in the period
  // ------------------------------------------------------------------
  const { data: activeDecisions7d } = await supabase
    .from('decisions')
    .select('org_id')
    .gte('created_at', cutoff7d);

  const { data: activeDecisions30d } = await supabase
    .from('decisions')
    .select('org_id')
    .gte('created_at', cutoff30d);

  const activeOrgIds7d = new Set((activeDecisions7d || []).map((d) => d.org_id));
  const activeOrgIds30d = new Set((activeDecisions30d || []).map((d) => d.org_id));

  // Also consider audit_entries as activity signal
  const { data: auditActivity7d } = await supabase
    .from('audit_entries')
    .select('org_id')
    .gte('created_at', cutoff7d);

  const { data: auditActivity30d } = await supabase
    .from('audit_entries')
    .select('org_id')
    .gte('created_at', cutoff30d);

  for (const a of auditActivity7d || []) activeOrgIds7d.add(a.org_id);
  for (const a of auditActivity30d || []) activeOrgIds30d.add(a.org_id);

  // ------------------------------------------------------------------
  // 4. Average decisions per org (within period)
  // ------------------------------------------------------------------
  const { count: totalDecisionsInPeriod } = await supabase
    .from('decisions')
    .select('*', { count: 'exact', head: true })
    .gte('created_at', periodCutoff);

  const activeOrgCountForAvg = period === '7d' ? activeOrgIds7d.size : activeOrgIds30d.size;
  const avgDecisionsPerOrg =
    activeOrgCountForAvg > 0
      ? Math.round((totalDecisionsInPeriod || 0) / activeOrgCountForAvg)
      : 0;

  // ------------------------------------------------------------------
  // 5. Average searches per org — derive from rate_limits table
  // ------------------------------------------------------------------
  const { data: rateLimits } = await supabase
    .from('rate_limits')
    .select('org_id, search_count')
    .gte('window_start', periodCutoff);

  let totalSearches = 0;
  const searchOrgs = new Set<string>();
  for (const rl of rateLimits || []) {
    totalSearches += rl.search_count || 0;
    searchOrgs.add(rl.org_id);
  }
  const avgSearchesPerOrg =
    searchOrgs.size > 0 ? Math.round(totalSearches / searchOrgs.size) : 0;

  // ------------------------------------------------------------------
  // 6. COGS estimate — fixed costs spread across max(actual, baseline)
  // ------------------------------------------------------------------
  const orgDivisor = Math.max(totalOrgs || 1, COGS_BASELINE_ORGS);
  const estimatedCogsPerOrg =
    Math.round(
      ((25 / orgDivisor) + (35 / orgDivisor)) * 100,
    ) / 100;

  // ------------------------------------------------------------------
  // 7. Activation funnel
  //    - Created: total orgs
  //    - First store <24h: orgs whose earliest decision is within 24h of org creation
  //    - Weekly active: orgs active in last 7d
  // ------------------------------------------------------------------
  const { data: earliestDecisions } = await supabase
    .from('decisions')
    .select('org_id, created_at')
    .order('created_at', { ascending: true });

  // Find earliest decision per org
  const firstDecisionByOrg = new Map<string, string>();
  for (const d of earliestDecisions || []) {
    if (!firstDecisionByOrg.has(d.org_id)) {
      firstDecisionByOrg.set(d.org_id, d.created_at);
    }
  }

  let firstStoreWithin24h = 0;
  for (const [orgId, firstDecisionAt] of firstDecisionByOrg) {
    const orgInfo = orgMap.get(orgId);
    if (!orgInfo) continue;
    const orgCreated = new Date(orgInfo.created_at).getTime();
    const firstStore = new Date(firstDecisionAt).getTime();
    const diffHours = (firstStore - orgCreated) / (1000 * 60 * 60);
    if (diffHours <= 24) {
      firstStoreWithin24h++;
    }
  }

  // ------------------------------------------------------------------
  // 8. Churn / at-risk: orgs with zero activity in last 30d
  // ------------------------------------------------------------------
  const atRiskOrgs: AtRiskOrg[] = [];
  for (const [orgId, info] of orgMap) {
    if (!activeOrgIds30d.has(orgId)) {
      // Find last activity — latest decision or audit entry
      let lastActivity: string | null = null;

      const { data: lastDec } = await supabase
        .from('decisions')
        .select('created_at')
        .eq('org_id', orgId)
        .order('created_at', { ascending: false })
        .limit(1);

      if (lastDec && lastDec.length > 0) {
        lastActivity = lastDec[0].created_at;
      }

      if (!lastActivity) {
        // Use org creation date as fallback
        lastActivity = info.created_at;
      }

      atRiskOrgs.push({
        org_id: orgId,
        org_name: info.name,
        last_activity: lastActivity,
      });
    }
  }

  // Sort at-risk by last activity ascending (most stale first)
  atRiskOrgs.sort(
    (a, b) => new Date(a.last_activity).getTime() - new Date(b.last_activity).getTime(),
  );

  // ------------------------------------------------------------------
  // 9. Active members — distinct authors in decisions within period
  // ------------------------------------------------------------------
  const { data: authorsInPeriod } = await supabase
    .from('decisions')
    .select('author')
    .gte('created_at', periodCutoff);

  const distinctAuthors = new Set((authorsInPeriod || []).map((d) => d.author));

  // ------------------------------------------------------------------
  // Assemble result
  // ------------------------------------------------------------------
  return {
    period,
    generated_at: now.toISOString(),

    total_orgs: totalOrgs || 0,
    active_orgs_7d: activeOrgIds7d.size,
    active_orgs_30d: activeOrgIds30d.size,

    avg_decisions_per_org: avgDecisionsPerOrg,
    avg_searches_per_org: avgSearchesPerOrg,
    estimated_cogs_per_org: estimatedCogsPerOrg,

    activation: {
      created: totalOrgs || 0,
      first_store_within_24h: firstStoreWithin24h,
      weekly_active: activeOrgIds7d.size,
    },

    churned_orgs_30d: atRiskOrgs.length,
    at_risk_orgs: atRiskOrgs,

    active_members: distinctAuthors.size,
  };
}
