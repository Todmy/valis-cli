/**
 * T063: Synthesis runner — orchestrate pattern detection, idempotency,
 * pattern creation, stale deprecation, and audit entries.
 *
 * Pipeline:
 * 1. Fetch active decisions from time window
 * 2. Detect pattern candidates
 * 3. Idempotency check — skip if existing pattern overlaps >0.8 on depends_on
 * 4. Create new patterns via normal store pipeline (source = 'synthesis')
 * 5. Deprecate stale patterns (all source decisions deprecated)
 * 6. Create audit entries and push notifications
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Decision, PatternCandidate } from '../types.js';
import {
  detectPatterns,
  jaccard,
  patternSummary,
  type ClusterDecision,
} from './patterns.js';
import { storeDecision, changeDecisionStatus } from '../cloud/supabase.js';
import { buildAuditPayload, createAuditEntry } from '../auth/audit.js';

// ---------------------------------------------------------------------------
// Synthesis report
// ---------------------------------------------------------------------------

export interface SynthesisReport {
  mode: 'dry_run' | 'applied';
  candidates_detected: number;
  patterns_created: number;
  patterns_skipped_idempotent: number;
  stale_patterns_deprecated: number;
  errors: Array<{ area: string; error: string }>;
  candidates: PatternCandidate[];
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface SynthesisOptions {
  orgId: string;
  windowDays: number;
  minCluster: number;
  dryRun: boolean;
  memberId?: string;
}

// ---------------------------------------------------------------------------
// Fetch active decisions from window
// ---------------------------------------------------------------------------

async function fetchActiveDecisions(
  supabase: SupabaseClient,
  orgId: string,
  windowDays: number,
): Promise<ClusterDecision[]> {
  const since = new Date(Date.now() - windowDays * 86_400_000).toISOString();

  const { data, error } = await supabase
    .from('decisions')
    .select('id, affects, summary, type, created_at')
    .eq('org_id', orgId)
    .eq('status', 'active')
    .gte('created_at', since);

  if (error) throw new Error(`Failed to fetch decisions: ${error.message}`);
  return (data ?? []) as ClusterDecision[];
}

// ---------------------------------------------------------------------------
// Idempotency check
// ---------------------------------------------------------------------------

/**
 * Check if an existing active synthesis pattern already covers this cluster.
 * Returns true if an existing pattern's depends_on has Jaccard > 0.8 overlap
 * with the candidate's decision_ids AND shares overlapping areas.
 */
async function patternAlreadyExists(
  supabase: SupabaseClient,
  orgId: string,
  candidate: PatternCandidate,
): Promise<boolean> {
  const { data, error } = await supabase
    .from('decisions')
    .select('id, depends_on, affects')
    .eq('org_id', orgId)
    .eq('type', 'pattern')
    .eq('source', 'synthesis')
    .eq('status', 'active')
    .overlaps('affects', candidate.affects);

  if (error || !data || data.length === 0) return false;

  for (const existing of data) {
    const existingDeps = (existing.depends_on as string[]) ?? [];
    if (existingDeps.length === 0) continue;

    const overlap = jaccard(existingDeps, candidate.decision_ids);
    if (overlap > 0.8) return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Stale pattern deprecation
// ---------------------------------------------------------------------------

/**
 * Find and deprecate patterns whose source decisions are all deprecated
 * or superseded.
 */
async function deprecateStalePatterns(
  supabase: SupabaseClient,
  orgId: string,
  memberId: string,
): Promise<number> {
  // Fetch all active synthesis patterns
  const { data: patterns, error } = await supabase
    .from('decisions')
    .select('id, depends_on')
    .eq('org_id', orgId)
    .eq('type', 'pattern')
    .eq('source', 'synthesis')
    .eq('status', 'active');

  if (error || !patterns || patterns.length === 0) return 0;

  let deprecated = 0;
  for (const pattern of patterns) {
    const dependsOn = (pattern.depends_on as string[]) ?? [];
    if (dependsOn.length === 0) continue;

    // Check status of all source decisions
    const { data: sources } = await supabase
      .from('decisions')
      .select('id, status')
      .in('id', dependsOn);

    const allDeprecated = (sources ?? []).every(
      (s: { status: string }) =>
        s.status === 'deprecated' || s.status === 'superseded',
    );

    if (allDeprecated && (sources ?? []).length > 0) {
      try {
        await changeDecisionStatus(
          supabase,
          orgId,
          pattern.id as string,
          'deprecated',
          'system',
          'All source decisions deprecated',
        );
        deprecated++;
      } catch {
        // Best-effort deprecation
      }
    }
  }

  return deprecated;
}

// ---------------------------------------------------------------------------
// Main runner
// ---------------------------------------------------------------------------

export async function runSynthesis(
  supabase: SupabaseClient,
  options: SynthesisOptions,
): Promise<SynthesisReport> {
  const { orgId, windowDays, minCluster, dryRun, memberId } = options;

  const report: SynthesisReport = {
    mode: dryRun ? 'dry_run' : 'applied',
    candidates_detected: 0,
    patterns_created: 0,
    patterns_skipped_idempotent: 0,
    stale_patterns_deprecated: 0,
    errors: [],
    candidates: [],
  };

  // 1. Fetch active decisions from time window
  const decisions = await fetchActiveDecisions(supabase, orgId, windowDays);
  if (decisions.length === 0) return report;

  // 2. Detect pattern candidates
  const candidates = detectPatterns(decisions, minCluster, windowDays);
  report.candidates_detected = candidates.length;

  // 3. For each candidate: idempotency check, then create
  for (const candidate of candidates) {
    try {
      // Idempotency check
      const exists = await patternAlreadyExists(supabase, orgId, candidate);
      if (exists) {
        candidate.already_exists = true;
        report.patterns_skipped_idempotent++;
        report.candidates.push(candidate);
        continue;
      }

      report.candidates.push(candidate);

      if (dryRun) continue;

      // Create pattern via normal store pipeline
      const summary = patternSummary(
        candidate.affects,
        candidate.decision_ids.length,
        windowDays,
      );

      const confidence = Math.min(
        1.0,
        candidate.decision_ids.length / decisions.length,
      );

      const decision = await storeDecision(
        supabase,
        orgId,
        {
          text: summary,
          type: 'pattern',
          summary,
          affects: candidate.affects,
          confidence,
        },
        'system',
        'synthesis',
        { depends_on: candidate.decision_ids },
      );

      // Create audit entry
      try {
        const auditPayload = buildAuditPayload(
          'pattern_synthesized',
          'decision',
          decision.id,
          memberId ?? 'system',
          orgId,
          {
            newState: {
              areas: candidate.affects,
              source_count: candidate.decision_ids.length,
              cohesion: candidate.cohesion,
            },
            reason: `Pattern detected: ${candidate.affects.join(', ')}`,
          },
        );
        await createAuditEntry(supabase, auditPayload);
      } catch {
        // Audit failures are non-fatal
      }

      report.patterns_created++;
    } catch (err) {
      report.errors.push({
        area: candidate.affects.join(', '),
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // 4. Deprecate stale patterns (only when applying)
  if (!dryRun) {
    try {
      report.stale_patterns_deprecated = await deprecateStalePatterns(
        supabase,
        orgId,
        memberId ?? 'system',
      );
    } catch {
      // Best-effort
    }
  }

  return report;
}
