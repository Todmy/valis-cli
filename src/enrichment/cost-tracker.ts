/**
 * T055: Daily cost ceiling tracker for LLM enrichment.
 *
 * Tracks per-org, per-provider daily spend via the enrichment_usage table.
 * Uses the increment_enrichment_usage RPC to atomically update usage.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

/** Result of a ceiling check. */
export interface CeilingCheck {
  /** Whether enrichment is allowed (under ceiling). */
  allowed: boolean;
  /** Amount already spent today (in cents). */
  spent: number;
  /** Remaining budget today (in cents, clamped to 0). */
  remaining: number;
}

/** Default daily cost ceiling in cents ($1.00). */
export const DEFAULT_CEILING_CENTS = 100;

/**
 * Return today's date as YYYY-MM-DD string (UTC).
 */
function today(): string {
  return new Date().toISOString().split('T')[0];
}

/**
 * Check whether the org is within the daily cost ceiling for a provider.
 *
 * Reads the enrichment_usage table for today's date and provider.
 * Returns { allowed, spent, remaining }.
 */
export async function checkCeiling(
  supabase: SupabaseClient,
  orgId: string,
  provider: string,
  ceilingCents: number = DEFAULT_CEILING_CENTS,
): Promise<CeilingCheck> {
  const { data } = await supabase
    .from('enrichment_usage')
    .select('cost_cents')
    .eq('org_id', orgId)
    .eq('date', today())
    .eq('provider', provider)
    .maybeSingle();

  const spent = (data?.cost_cents as number) ?? 0;

  return {
    allowed: spent < ceilingCents,
    spent,
    remaining: Math.max(0, ceilingCents - spent),
  };
}

/**
 * Record enrichment usage after a successful LLM call.
 *
 * Calls the increment_enrichment_usage RPC which upserts the daily record
 * (creates if not exists, increments if exists).
 */
export async function trackUsage(
  supabase: SupabaseClient,
  orgId: string,
  provider: string,
  tokensUsed: number,
  costCents: number,
): Promise<void> {
  const { error } = await supabase.rpc('increment_enrichment_usage', {
    p_org_id: orgId,
    p_date: today(),
    p_provider: provider,
    p_decisions: 1,
    p_tokens: tokensUsed,
    p_cost_cents: costCents,
  });

  if (error) {
    // Usage tracking failures are non-fatal — log and continue
    console.warn(`[teamind] enrichment usage tracking failed: ${error.message}`);
  }
}

/**
 * Get total daily spend across all providers for an org.
 *
 * Useful for aggregate ceiling checks when using multiple providers.
 */
export async function getDailyCost(
  supabase: SupabaseClient,
  orgId: string,
): Promise<number> {
  const { data } = await supabase
    .from('enrichment_usage')
    .select('cost_cents')
    .eq('org_id', orgId)
    .eq('date', today());

  if (!data || data.length === 0) return 0;

  return data.reduce((sum, row) => sum + ((row.cost_cents as number) ?? 0), 0);
}
