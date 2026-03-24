/**
 * Cleanup runner — orchestrates dedup + orphan detection.
 *
 * T024: Combines exact-duplicate auto-deprecation, near-duplicate flagging,
 * and stale orphan detection into a single CleanupReport.
 *
 * - `--dry-run` (default): reports without mutations.
 * - `--apply`: auto-deprecates exact dupes + creates audit entries.
 *
 * @module cleanup/runner
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { QdrantClient } from '@qdrant/js-client-rest';
import type { CleanupReport, Decision } from '../types.js';
import { findExactDuplicates, findNearDuplicates } from './dedup.js';
import { findStaleOrphans } from './orphans.js';
import { changeDecisionStatus } from '../cloud/supabase.js';
import { buildAuditPayload, createAuditEntry } from '../auth/audit.js';

// -------------------------------------------------------------------------
// Audit action constants (T024)
// -------------------------------------------------------------------------

/** Audit action for auto-deduplication of an exact-duplicate decision. */
export const AUDIT_ACTION_AUTO_DEDUPED = 'decision_auto_deduped' as const;

/** Audit action constant for orphan flagging (report-only today). */
export const AUDIT_ACTION_ORPHAN_FLAGGED = 'decision_orphan_flagged' as const;

// -------------------------------------------------------------------------
// Options
// -------------------------------------------------------------------------

export interface CleanupOptions {
  /** When true, execute mutations (deprecate exact dupes + audit). */
  apply: boolean;
  /** Target org ID. */
  orgId: string;
  /** Member ID for audit attribution. */
  memberId: string;
  /** Near-duplicate cosine similarity threshold (default 0.9). */
  nearThreshold?: number;
  /** Orphan staleness in days (default 30). */
  staleDays?: number;
}

// -------------------------------------------------------------------------
// Runner
// -------------------------------------------------------------------------

/**
 * Run the full cleanup pipeline: exact dedup, near-duplicate detection, and
 * stale orphan identification.
 *
 * Returns a `CleanupReport` summarising what was found (dry-run) or what
 * was applied.
 */
export async function runCleanup(
  supabase: SupabaseClient,
  qdrant: QdrantClient,
  options: CleanupOptions,
): Promise<CleanupReport> {
  const {
    apply,
    orgId,
    memberId,
    nearThreshold = 0.9,
    staleDays = 30,
  } = options;

  // 1. Exact-duplicate detection
  const exactCandidates = await findExactDuplicates(supabase, orgId);

  // 2. Fetch all active decisions for near-duplicate scan
  const { data: activeDecisions } = await supabase
    .from('decisions')
    .select('*')
    .eq('org_id', orgId)
    .eq('status', 'active')
    .order('created_at', { ascending: false });

  const decisions = (activeDecisions ?? []) as Decision[];

  // 3. Near-duplicate detection
  const nearCandidates = await findNearDuplicates(
    qdrant,
    orgId,
    decisions,
    nearThreshold,
  );

  // 4. Stale orphan detection
  const orphans = await findStaleOrphans(supabase, orgId, staleDays);

  // 5. If --apply, auto-deprecate exact duplicates and create audit entries
  let auditEntriesCreated = 0;
  let exactDecisionsDeprecated = 0;

  if (apply) {
    for (const candidate of exactCandidates) {
      for (const deprecateId of candidate.deprecateIds) {
        try {
          await changeDecisionStatus(
            supabase,
            orgId,
            deprecateId,
            'deprecated',
            memberId,
            'auto-dedup: exact content hash match',
          );

          const auditPayload = buildAuditPayload(
            'decision_auto_deduped',
            'decision',
            deprecateId,
            memberId,
            orgId,
            {
              previousState: { status: 'active' },
              newState: {
                status: 'deprecated',
                status_reason: 'auto-dedup: exact content hash match',
              },
              reason: `Exact duplicate of ${candidate.keepId}`,
            },
          );

          await createAuditEntry(supabase, auditPayload);
          auditEntriesCreated++;
          exactDecisionsDeprecated++;
        } catch {
          // Individual failure does not halt the batch
        }
      }
    }
  }

  // 6. Build report
  const report: CleanupReport = {
    exact_dupes_deprecated: apply ? exactDecisionsDeprecated : 0,
    near_dupes_flagged: nearCandidates.reduce((n, c) => n + c.deprecateIds.length, 0),
    orphans_flagged: orphans.length,
    dry_run: !apply,
    exact_dupes: exactCandidates.map((c) => ({
      kept_id: c.keepId,
      deprecated_ids: c.deprecateIds,
    })),
    near_dupes: nearCandidates.flatMap((c) =>
      c.deprecateIds.map((depId) => ({
        decision_a_id: c.keepId,
        decision_b_id: depId,
        similarity: c.similarity,
      })),
    ),
    orphans: orphans.map((o) => ({
      decision_id: o.decisionId,
      age_days: o.ageDays,
    })),
  };

  return report;
}
