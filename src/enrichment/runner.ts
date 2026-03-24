/**
 * T056: Enrichment runner — orchestrates LLM classification of pending decisions.
 *
 * Pipeline:
 *   1. Resolve provider (with graceful no-key exit).
 *   2. Fetch pending decisions from Postgres.
 *   3. In dry-run mode, report candidates without mutations.
 *   4. For each pending decision (respecting daily ceiling):
 *      a. Call LLM provider to classify.
 *      b. Update Postgres (type, summary, affects, enriched_by).
 *      c. Update Qdrant payload.
 *      d. Create audit entry (decision_enriched).
 *      e. Track usage.
 *   5. Return an enrichment report.
 *
 * Completely isolated — never imported by core operations.
 *
 * @module enrichment/runner
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { QdrantClient } from '@qdrant/js-client-rest';
import type { Decision, EnrichmentResult, AuditAction } from '../types.js';
import type { EnrichmentProvider } from './provider.js';
import { AnthropicProvider } from './anthropic.js';
import { OpenAIProvider } from './openai.js';
import { checkCeiling, trackUsage, DEFAULT_CEILING_CENTS } from './cost-tracker.js';
import { createAuditEntry } from '../auth/audit.js';
import { COLLECTION_NAME } from '../cloud/qdrant.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const AUDIT_ACTION_ENRICHED: AuditAction = 'decision_enriched';

// ---------------------------------------------------------------------------
// Options & Report
// ---------------------------------------------------------------------------

export interface EnrichOptions {
  /** Target org ID. */
  orgId: string;
  /** Member ID for audit attribution. */
  memberId: string;
  /** When true, report candidates without mutations or LLM calls. */
  dryRun: boolean;
  /** Provider override (defaults to auto-detect from env). */
  provider?: 'anthropic' | 'openai';
  /** Daily cost ceiling in cents (default 100 = $1.00). */
  ceilingCents?: number;
}

export interface EnrichmentReport {
  /** Mode the runner executed in. */
  mode: 'dry_run' | 'applied' | 'no_provider';
  /** Number of decisions enriched. */
  enriched: number;
  /** Number of decisions that failed enrichment. */
  failed: number;
  /** Total pending candidates found. */
  candidates: number;
  /** Remaining candidates not processed (ceiling hit or batch end). */
  remaining: number;
  /** Per-decision details (populated in non-dry-run mode). */
  details: EnrichmentResult[];
  /** Human-readable message. */
  message: string;
}

// ---------------------------------------------------------------------------
// Provider resolution
// ---------------------------------------------------------------------------

/**
 * Resolve an LLM provider from environment variables.
 *
 * Priority:
 *   1. Explicit `--provider` flag.
 *   2. ANTHROPIC_API_KEY env var -> Anthropic.
 *   3. OPENAI_API_KEY env var -> OpenAI.
 *   4. null (no provider available).
 */
export function getProvider(preferred?: 'anthropic' | 'openai'): EnrichmentProvider | null {
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;

  if (preferred === 'anthropic') {
    if (!anthropicKey) return null;
    return new AnthropicProvider(anthropicKey);
  }

  if (preferred === 'openai') {
    if (!openaiKey) return null;
    return new OpenAIProvider(openaiKey);
  }

  // Auto-detect: prefer Anthropic, fall back to OpenAI
  if (anthropicKey) return new AnthropicProvider(anthropicKey);
  if (openaiKey) return new OpenAIProvider(openaiKey);

  return null;
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

/**
 * Execute the enrichment pipeline.
 *
 * Gracefully exits when no LLM provider is configured — pending decisions
 * are left untouched and core operations are never affected.
 */
export async function runEnrichment(
  supabase: SupabaseClient,
  qdrant: QdrantClient,
  options: EnrichOptions,
): Promise<EnrichmentReport> {
  const {
    orgId,
    memberId,
    dryRun,
    provider: preferredProvider,
    ceilingCents = DEFAULT_CEILING_CENTS,
  } = options;

  // 1. Resolve provider ---------------------------------------------------
  const provider = getProvider(preferredProvider);
  if (!provider) {
    return {
      mode: 'no_provider',
      enriched: 0,
      failed: 0,
      candidates: 0,
      remaining: 0,
      details: [],
      message: 'No LLM provider configured. Set ANTHROPIC_API_KEY or OPENAI_API_KEY. Pending decisions unchanged.',
    };
  }

  // 2. Fetch pending decisions --------------------------------------------
  const { data: pending, error: fetchError } = await supabase
    .from('decisions')
    .select('*')
    .eq('org_id', orgId)
    .eq('type', 'pending')
    .order('created_at', { ascending: true });

  if (fetchError) {
    throw new Error(`Failed to fetch pending decisions: ${fetchError.message}`);
  }

  const candidates = (pending ?? []) as Decision[];

  if (candidates.length === 0) {
    return {
      mode: dryRun ? 'dry_run' : 'applied',
      enriched: 0,
      failed: 0,
      candidates: 0,
      remaining: 0,
      details: [],
      message: 'No pending decisions to enrich.',
    };
  }

  // 3. Dry-run: report without changes ------------------------------------
  if (dryRun) {
    return {
      mode: 'dry_run',
      enriched: 0,
      failed: 0,
      candidates: candidates.length,
      remaining: candidates.length,
      details: [],
      message: `Found ${candidates.length} pending decision(s). Omit --dry-run to enrich.`,
    };
  }

  // 4. Enrich each decision (respecting ceiling) --------------------------
  let enriched = 0;
  let failed = 0;
  const details: EnrichmentResult[] = [];

  for (const decision of candidates) {
    // Check ceiling before each call
    const ceiling = await checkCeiling(supabase, orgId, provider.name, ceilingCents);
    if (!ceiling.allowed) {
      const remaining = candidates.length - enriched - failed;
      return {
        mode: 'applied',
        enriched,
        failed,
        candidates: candidates.length,
        remaining,
        details,
        message: `Daily cost ceiling reached ($${(ceiling.spent / 100).toFixed(2)} of $${(ceilingCents / 100).toFixed(2)}). ${enriched} enriched, ${remaining} remaining. Resuming tomorrow.`,
      };
    }

    try {
      // Call the LLM
      const result = await provider.enrich(decision.detail);
      const costCents = Math.ceil(result.tokensUsed * provider.estimatedCostPerToken * 100);

      // Update Postgres
      const { error: updateError } = await supabase
        .from('decisions')
        .update({
          type: result.type,
          summary: result.summary,
          affects: result.affects,
          enriched_by: 'llm',
        })
        .eq('id', decision.id)
        .eq('org_id', orgId);

      if (updateError) {
        throw new Error(`Postgres update failed: ${updateError.message}`);
      }

      // Update Qdrant payload
      try {
        await qdrant.setPayload(COLLECTION_NAME, {
          payload: {
            type: result.type,
            summary: result.summary,
            affects: result.affects,
          },
          points: [decision.id],
        });
      } catch {
        // Qdrant update failures are non-fatal — Postgres is source of truth
        console.warn(`[teamind] Qdrant payload update failed for ${decision.id}`);
      }

      // Create audit entry
      await createAuditEntry(supabase, {
        org_id: orgId,
        member_id: memberId,
        action: AUDIT_ACTION_ENRICHED,
        target_type: 'decision',
        target_id: decision.id,
        previous_state: {
          type: decision.type,
          summary: decision.summary,
          affects: decision.affects,
        },
        new_state: {
          type: result.type,
          summary: result.summary,
          affects: result.affects,
          enriched_by: 'llm',
        },
        reason: `Enriched by ${provider.name}`,
      });

      // Track usage
      await trackUsage(supabase, orgId, provider.name, result.tokensUsed, costCents);

      details.push({
        decision_id: decision.id,
        type: result.type,
        summary: result.summary,
        affects: result.affects,
        confidence: decision.confidence ?? 0,
        provider: provider.name,
        cost_cents: costCents,
        tokens_used: result.tokensUsed,
      });

      enriched++;
    } catch (err) {
      // Individual failures do not halt the batch
      failed++;
      console.warn(
        `[teamind] enrichment failed for ${decision.id}: ${(err as Error).message}`,
      );
    }
  }

  return {
    mode: 'applied',
    enriched,
    failed,
    candidates: candidates.length,
    remaining: 0,
    details,
    message: `Enriched ${enriched}/${candidates.length} pending decision(s) via ${provider.name}.${failed > 0 ? ` ${failed} failed.` : ''}`,
  };
}
