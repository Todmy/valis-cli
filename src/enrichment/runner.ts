/**
 * T056: Enrichment runner — orchestrates LLM enrichment of pending decisions.
 *
 * Fetches pending decisions, calls the configured provider, updates Postgres
 * and Qdrant, creates audit entries, and respects the daily cost ceiling.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { QdrantClient } from '@qdrant/js-client-rest';
import type { Decision } from '../types.js';
import type { EnrichmentProvider } from './provider.js';
import { AnthropicProvider } from './anthropic.js';
import { OpenAIProvider } from './openai.js';
import { checkCeiling, trackUsage, DEFAULT_CEILING_CENTS } from './cost-tracker.js';
import { buildAuditPayload, createAuditEntry } from '../auth/audit.js';
import { COLLECTION_NAME } from '../cloud/qdrant.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EnrichOptions {
  /** Override provider name ('anthropic' | 'openai'). */
  provider?: string;
  /** Dry-run mode — report without mutations or LLM calls. */
  dryRun?: boolean;
  /** Daily cost ceiling in cents. Default: 100 ($1.00). */
  ceilingCents?: number;
  /** Org ID to enrich for. */
  orgId: string;
  /** Member ID for audit entries. */
  memberId: string;
}

export interface EnrichmentReport {
  /** Run mode. */
  mode: 'dry_run' | 'applied' | 'no_provider' | 'no_pending';
  /** Number of decisions enriched. */
  enriched: number;
  /** Number of decisions skipped (ceiling, errors). */
  skipped: number;
  /** Estimated total cost in cents. */
  costCents: number;
  /** Total pending candidates found. */
  candidates: number;
  /** Human-readable message. */
  message: string;
  /** Per-decision errors (non-fatal). */
  errors: Array<{ decisionId: string; error: string }>;
}

// ---------------------------------------------------------------------------
// Provider resolution
// ---------------------------------------------------------------------------

/**
 * Resolve an EnrichmentProvider from env vars / explicit name.
 *
 * Checks for API keys in environment:
 * - ANTHROPIC_API_KEY -> AnthropicProvider
 * - OPENAI_API_KEY    -> OpenAIProvider
 *
 * Returns null when no provider can be configured (graceful no-key path).
 */
export function getProvider(preferredProvider?: string): EnrichmentProvider | null {
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;

  // Explicit provider override
  if (preferredProvider === 'anthropic') {
    if (!anthropicKey) return null;
    return new AnthropicProvider(anthropicKey);
  }
  if (preferredProvider === 'openai') {
    if (!openaiKey) return null;
    return new OpenAIProvider(openaiKey);
  }

  // Auto-detect: prefer Anthropic, fallback to OpenAI
  if (anthropicKey) return new AnthropicProvider(anthropicKey);
  if (openaiKey) return new OpenAIProvider(openaiKey);

  return null;
}

// ---------------------------------------------------------------------------
// Pending decisions query
// ---------------------------------------------------------------------------

async function fetchPendingDecisions(
  supabase: SupabaseClient,
  orgId: string,
): Promise<Decision[]> {
  const { data, error } = await supabase
    .from('decisions')
    .select('*')
    .eq('org_id', orgId)
    .eq('type', 'pending')
    .order('created_at', { ascending: true });

  if (error) throw new Error(`Failed to fetch pending decisions: ${error.message}`);
  return (data ?? []) as Decision[];
}

// ---------------------------------------------------------------------------
// Main runner
// ---------------------------------------------------------------------------

/**
 * Run the enrichment pipeline for an organization.
 *
 * 1. Resolve provider (graceful exit if no key).
 * 2. Fetch pending decisions.
 * 3. Dry-run: report candidates without changes.
 * 4. For each decision: check ceiling, call provider, update DB + Qdrant, audit.
 */
export async function runEnrichment(
  supabase: SupabaseClient,
  qdrant: QdrantClient | null,
  options: EnrichOptions,
): Promise<EnrichmentReport> {
  // 1. Check for provider configuration (T059: graceful no-key path)
  const provider = getProvider(options.provider);
  if (!provider) {
    return {
      mode: 'no_provider',
      enriched: 0,
      skipped: 0,
      costCents: 0,
      candidates: 0,
      message: 'No LLM provider configured. Set ANTHROPIC_API_KEY or OPENAI_API_KEY. Pending decisions unchanged.',
      errors: [],
    };
  }

  // 2. Fetch pending decisions
  const pending = await fetchPendingDecisions(supabase, options.orgId);
  if (pending.length === 0) {
    return {
      mode: 'no_pending',
      enriched: 0,
      skipped: 0,
      costCents: 0,
      candidates: 0,
      message: 'No pending decisions to enrich.',
      errors: [],
    };
  }

  // 3. Dry-run: report without changes
  if (options.dryRun) {
    return {
      mode: 'dry_run',
      enriched: 0,
      skipped: 0,
      costCents: 0,
      candidates: pending.length,
      message: `Dry run: ${pending.length} pending decision(s) would be enriched using ${provider.name}.`,
      errors: [],
    };
  }

  // 4. Enrich each decision (respecting ceiling)
  const ceilingCents = options.ceilingCents ?? DEFAULT_CEILING_CENTS;
  let enriched = 0;
  let totalCostCents = 0;
  const errors: Array<{ decisionId: string; error: string }> = [];

  for (const decision of pending) {
    // T060: Check cost ceiling before each call
    const ceiling = await checkCeiling(supabase, options.orgId, provider.name, ceilingCents);
    if (!ceiling.allowed) {
      const skipped = pending.length - enriched;
      return {
        mode: 'applied',
        enriched,
        skipped,
        costCents: totalCostCents,
        candidates: pending.length,
        message: `Daily cost ceiling reached ($${(ceiling.spent / 100).toFixed(2)} spent). ${enriched} enriched, ${skipped} skipped. Resuming tomorrow.`,
        errors,
      };
    }

    try {
      // Call LLM provider
      const result = await provider.enrich(decision.detail);
      const costCents = Math.ceil(result.tokensUsed * provider.estimatedCostPerToken * 100);

      // Update decision in Postgres
      const { error: updateError } = await supabase
        .from('decisions')
        .update({
          type: result.type,
          summary: result.summary,
          affects: result.affects,
          enriched_by: 'llm' as const,
        })
        .eq('id', decision.id)
        .eq('org_id', options.orgId);

      if (updateError) {
        throw new Error(`Postgres update failed: ${updateError.message}`);
      }

      // Update Qdrant payload (if client available)
      if (qdrant) {
        try {
          await qdrant.setPayload(COLLECTION_NAME, {
            payload: {
              type: result.type,
              summary: result.summary,
              affects: result.affects,
            },
            points: [decision.id],
          });
        } catch (qdrantErr) {
          // Qdrant update failure is non-fatal — Postgres is source of truth
          console.warn(`[teamind] Qdrant payload update failed for ${decision.id}: ${(qdrantErr as Error).message}`);
        }
      }

      // Track usage
      await trackUsage(supabase, options.orgId, provider.name, result.tokensUsed, costCents);

      // Create audit entry
      const auditPayload = buildAuditPayload(
        'decision_enriched',
        'decision',
        decision.id,
        options.memberId,
        options.orgId,
        {
          previousState: { type: 'pending', summary: null, affects: [] },
          newState: { type: result.type, summary: result.summary, affects: result.affects },
          reason: `Enriched by ${provider.name}`,
        },
      );
      await createAuditEntry(supabase, auditPayload);

      enriched++;
      totalCostCents += costCents;
    } catch (err) {
      // Individual decision failure is non-fatal
      errors.push({
        decisionId: decision.id,
        error: (err as Error).message,
      });
    }
  }

  return {
    mode: 'applied',
    enriched,
    skipped: errors.length,
    costCents: totalCostCents,
    candidates: pending.length,
    message: `Enriched ${enriched}/${pending.length} pending decisions using ${provider.name}. Cost: $${(totalCostCents / 100).toFixed(2)}.`,
    errors,
  };
}
