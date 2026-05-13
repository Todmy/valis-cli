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

import type { PatternCandidate } from '../types.js';
import {
  detectPatterns,
  jaccard,
  patternSummary,
} from './patterns.js';
import type { SynthesisStore } from './store.js';
import { buildAuditPayload } from '../auth/audit.js';

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
// Idempotency check (in-process — store provides the rows)
// ---------------------------------------------------------------------------

async function patternAlreadyExists(
  store: SynthesisStore,
  orgId: string,
  candidate: PatternCandidate,
): Promise<boolean> {
  const existing = await store.findActiveSynthesisPatterns(orgId, candidate.affects);
  for (const row of existing) {
    if (row.depends_on.length === 0) continue;
    if (jaccard(row.depends_on, candidate.decision_ids) > 0.8) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Stale pattern deprecation
// ---------------------------------------------------------------------------

async function deprecateStalePatterns(store: SynthesisStore, orgId: string): Promise<number> {
  const patterns = await store.findActiveSynthesisPatterns(orgId);
  if (patterns.length === 0) return 0;

  let deprecated = 0;
  for (const pattern of patterns) {
    if (pattern.depends_on.length === 0) continue;
    const sources = await store.getDecisionStatuses(pattern.depends_on);
    if (sources.length === 0) continue;
    const allDeprecated = sources.every(
      (s) => s.status === 'deprecated' || s.status === 'superseded',
    );
    if (!allDeprecated) continue;
    try {
      await store.changePatternStatus(
        orgId,
        pattern.id,
        'deprecated',
        'All source decisions deprecated',
      );
      deprecated++;
    } catch {
      // Best-effort deprecation
    }
  }
  return deprecated;
}

// ---------------------------------------------------------------------------
// Main runner
// ---------------------------------------------------------------------------

export async function runSynthesis(
  store: SynthesisStore,
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
  const decisions = await store.fetchActiveDecisions(orgId, windowDays);

  // BUG #174: previously an `if (decisions.length === 0) return report` here
  // short-circuited step 4 (stale-pattern deprecation). On a quiet team week
  // with no fresh active decisions, patterns whose source decisions were
  // deprecated long ago would linger in `valis_search` indefinitely.
  // Fix: only skip steps 2-3 (detection + creation) when there's no signal;
  // always run step 4.
  // 2. Detect pattern candidates (skip when window is empty)
  const candidates =
    decisions.length === 0 ? [] : detectPatterns(decisions, minCluster, windowDays);
  report.candidates_detected = candidates.length;

  // 3. For each candidate: idempotency check, then create
  for (const candidate of candidates) {
    try {
      const exists = await patternAlreadyExists(store, orgId, candidate);
      if (exists) {
        candidate.already_exists = true;
        report.patterns_skipped_idempotent++;
        report.candidates.push(candidate);
        continue;
      }

      report.candidates.push(candidate);

      if (dryRun) continue;

      const summary = patternSummary(
        candidate.affects,
        candidate.decision_ids.length,
        windowDays,
      );
      const confidence = Math.min(1.0, candidate.decision_ids.length / decisions.length);

      const created = await store.createPattern(
        orgId,
        summary,
        candidate.affects,
        confidence,
        candidate.decision_ids,
      );

      const auditPayload = buildAuditPayload(
        'pattern_synthesized',
        'decision',
        created.id,
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
      await store.recordAuditEntry(auditPayload);

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
      report.stale_patterns_deprecated = await deprecateStalePatterns(store, orgId);
    } catch {
      // Best-effort
    }
  }

  return report;
}
