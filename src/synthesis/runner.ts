/**
 * T062-T063-T066: Synthesis runner — orchestrates pattern detection,
 * idempotent creation, stale pattern deprecation, audit, and push notifications.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { PatternCandidate, Decision } from '../types.js';
import { detectPatterns, jaccard, type DetectPatternsOptions } from './patterns.js';
import { storeDecision, changeDecisionStatus } from '../cloud/supabase.js';
import { createAuditEntry, buildAuditPayload } from '../auth/audit.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SynthesisOptions extends DetectPatternsOptions {
  /** If true, report patterns without creating decisions. */
  dryRun?: boolean;
  /** Member ID for audit entries. Falls back to 'system'. */
  memberId?: string;
}

export interface SynthesisReport {
  /** Whether this was a dry-run. */
  dry_run: boolean;
  /** Pattern candidates detected (including already-existing). */
  candidates: PatternCandidate[];
  /** Number of new pattern decisions created. */
  patterns_created: number;
  /** Number of stale patterns auto-deprecated. */
  patterns_deprecated: number;
  /** Error messages for individual failures (non-fatal). */
  errors: string[];
}

// ---------------------------------------------------------------------------
// Idempotency check
// ---------------------------------------------------------------------------

/**
 * Check whether a pattern with overlapping source decisions already exists.
 *
 * Queries active pattern decisions with source='synthesis' whose `affects`
 * overlap the candidate's areas, then computes Jaccard on the depends_on
 * arrays. Overlap > 0.8 means the pattern already exists.
 */
async function patternAlreadyExists(
  supabase: SupabaseClient,
  orgId: string,
  candidate: PatternCandidate,
): Promise<boolean> {
  const { data: existing, error } = await supabase
    .from('decisions')
    .select('id, depends_on, affects')
    .eq('org_id', orgId)
    .eq('type', 'pattern')
    .eq('source', 'synthesis')
    .eq('status', 'active')
    .overlaps('affects', candidate.affects);

  if (error || !existing || existing.length === 0) return false;

  for (const row of existing) {
    const existingDeps = (row.depends_on as string[]) ?? [];
    const overlap = jaccard(existingDeps, candidate.decision_ids);
    if (overlap > 0.8) return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Pattern creation
// ---------------------------------------------------------------------------

/**
 * Create a single pattern decision from a PatternCandidate.
 *
 * Stores via the normal pipeline (Postgres + Qdrant through storeDecision),
 * using source='synthesis' and type='pattern'.
 */
async function createPattern(
  supabase: SupabaseClient,
  orgId: string,
  candidate: PatternCandidate,
  memberId: string,
  windowDays: number,
): Promise<Decision> {
  const summary = `Team pattern: ${candidate.affects[0]} — ${candidate.decision_ids.length} decisions in ${windowDays} days`;

  const raw = {
    text: summary,
    type: 'pattern' as const,
    summary,
    affects: candidate.affects,
    confidence: Math.min(candidate.cohesion, 1),
  };

  const decision = await storeDecision(
    supabase,
    orgId,
    raw,
    'system',
    'synthesis',
    {
      status: 'active',
      depends_on: candidate.decision_ids,
    },
  );

  return decision;
}

// ---------------------------------------------------------------------------
// Stale pattern deprecation (T066)
// ---------------------------------------------------------------------------

/**
 * Auto-deprecate patterns when ALL of their source decisions are
 * deprecated or superseded.
 */
async function deprecateStalePatterns(
  supabase: SupabaseClient,
  orgId: string,
  memberId: string,
): Promise<{ deprecated: number; errors: string[] }> {
  const { data: patterns, error } = await supabase
    .from('decisions')
    .select('id, depends_on')
    .eq('org_id', orgId)
    .eq('type', 'pattern')
    .eq('source', 'synthesis')
    .eq('status', 'active');

  if (error || !patterns) return { deprecated: 0, errors: [] };

  let deprecated = 0;
  const errors: string[] = [];

  for (const pattern of patterns) {
    const dependsOn = (pattern.depends_on as string[]) ?? [];
    if (dependsOn.length === 0) continue;

    const { data: sources, error: srcErr } = await supabase
      .from('decisions')
      .select('id, status')
      .in('id', dependsOn);

    if (srcErr || !sources) continue;

    const allDeprecated = sources.every(
      (s: { status: string }) =>
        s.status === 'deprecated' || s.status === 'superseded',
    );

    if (allDeprecated) {
      try {
        await changeDecisionStatus(
          supabase,
          orgId,
          pattern.id as string,
          'deprecated',
          memberId,
          'All source decisions deprecated',
        );

        await createAuditEntry(
          supabase,
          buildAuditPayload(
            'decision_deprecated',
            'decision',
            pattern.id as string,
            memberId,
            orgId,
            {
              previousState: { status: 'active' },
              newState: { status: 'deprecated' },
              reason: 'Pattern auto-deprecated: all source decisions deprecated',
            },
          ),
        );

        deprecated++;
      } catch (err) {
        errors.push(
          `Failed to deprecate stale pattern ${pattern.id}: ${(err as Error).message}`,
        );
      }
    }
  }

  return { deprecated, errors };
}

// ---------------------------------------------------------------------------
// Main runner (T062)
// ---------------------------------------------------------------------------

/**
 * Run the full synthesis pipeline:
 *
 * 1. Detect pattern clusters via `detectPatterns`.
 * 2. For each candidate, check idempotency (skip if existing pattern
 *    has > 0.8 Jaccard overlap on depends_on).
 * 3. Create new pattern decisions with source='synthesis'.
 * 4. Create audit entries ('pattern_synthesized').
 * 5. Deprecate stale patterns (all source decisions deprecated).
 *
 * Push notifications happen automatically through Supabase Realtime
 * INSERT events on the decisions table (Phase 2 infrastructure).
 */
export async function runSynthesis(
  supabase: SupabaseClient,
  orgId: string,
  opts?: SynthesisOptions,
): Promise<SynthesisReport> {
  const dryRun = opts?.dryRun ?? false;
  const memberId = opts?.memberId ?? 'system';
  const windowDays = opts?.windowDays ?? 30;

  const report: SynthesisReport = {
    dry_run: dryRun,
    candidates: [],
    patterns_created: 0,
    patterns_deprecated: 0,
    errors: [],
  };

  // 1. Detect pattern clusters
  try {
    report.candidates = await detectPatterns(supabase, orgId, {
      windowDays: opts?.windowDays,
      minCluster: opts?.minCluster,
    });
  } catch (err) {
    report.errors.push(`Pattern detection failed: ${(err as Error).message}`);
    return report;
  }

  // 2. Mark existing patterns for idempotency
  for (const candidate of report.candidates) {
    try {
      candidate.already_exists = await patternAlreadyExists(
        supabase,
        orgId,
        candidate,
      );
    } catch (err) {
      report.errors.push(
        `Idempotency check failed for candidate [${candidate.affects.join(', ')}]: ${(err as Error).message}`,
      );
      // Mark as existing to be safe (skip creation)
      candidate.already_exists = true;
    }
  }

  // If dry-run, stop here
  if (dryRun) return report;

  // 3. Create new pattern decisions
  for (const candidate of report.candidates) {
    if (candidate.already_exists) continue;

    try {
      const decision = await createPattern(
        supabase,
        orgId,
        candidate,
        memberId,
        windowDays,
      );

      // 4. Create audit entry (T063 — 'pattern_synthesized')
      await createAuditEntry(
        supabase,
        buildAuditPayload(
          'pattern_synthesized',
          'decision',
          decision.id,
          memberId,
          orgId,
          {
            newState: {
              areas: candidate.affects,
              source_count: candidate.decision_ids.length,
              cohesion: candidate.cohesion,
            },
            reason: `Pattern detected: ${candidate.affects.join(', ')}`,
          },
        ),
      );

      report.patterns_created++;
    } catch (err) {
      report.errors.push(
        `Failed to create pattern for [${candidate.affects.join(', ')}]: ${(err as Error).message}`,
      );
    }
  }

  // 5. Deprecate stale patterns (T066)
  try {
    const staleResult = await deprecateStalePatterns(
      supabase,
      orgId,
      memberId,
    );
    report.patterns_deprecated = staleResult.deprecated;
    report.errors.push(...staleResult.errors);
  } catch (err) {
    report.errors.push(
      `Stale pattern deprecation failed: ${(err as Error).message}`,
    );
  }

  return report;
}
