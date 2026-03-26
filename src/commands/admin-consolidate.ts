/**
 * `valis admin consolidate` command — knowledge compression via semantic grouping.
 *
 * Usage:
 *   valis admin consolidate [--dry-run] [--auto-merge] [--threshold <n>]
 *
 * --dry-run (default): Show semantic groups and suggested actions. No mutations.
 * --auto-merge:        Execute merge for high-similarity groups (>0.9).
 * --threshold:         Cosine similarity threshold for grouping (default 0.7).
 *
 * When merging a group:
 *   1. Create a new pattern decision with the merged summary
 *   2. Set `depends_on` to all merged decision IDs
 *   3. Deprecate merged decisions (status -> 'deprecated', reason -> consolidated)
 *   4. Create audit entries for each action
 */

import pc from 'picocolors';
import { loadConfig } from '../config/store.js';
import { getSupabaseClient } from '../cloud/supabase.js';
import { getQdrantClient } from '../cloud/qdrant.js';
import {
  findSemanticGroups,
  type SemanticGroup,
} from '../cleanup/semantic-groups.js';
import { generateGroupSummary } from '../synthesis/summarize.js';
import { storeDecision, changeDecisionStatus } from '../cloud/supabase.js';
import { buildAuditPayload, createAuditEntry } from '../auth/audit.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AdminConsolidateOptions {
  dryRun?: boolean;
  autoMerge?: boolean;
  threshold?: string;
  org?: string;
}

export interface ConsolidationReport {
  mode: 'dry_run' | 'applied';
  groups_found: number;
  groups_merged: number;
  groups_review: number;
  groups_keep: number;
  decisions_deprecated: number;
  patterns_created: number;
  errors: Array<{ group_index: number; error: string }>;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function formatReport(
  report: ConsolidationReport,
  groups: SemanticGroup[],
): void {
  const modeLabel = report.mode === 'dry_run'
    ? pc.yellow('DRY RUN')
    : pc.green('APPLIED');

  console.log(`\n${pc.bold('Consolidation Report')} [${modeLabel}]`);
  console.log(pc.dim('\u2500'.repeat(50)));

  // Summary line
  const totalRedundant = groups
    .filter((g) => g.suggestedAction === 'merge')
    .reduce((sum, g) => sum + g.members.length - 1, 0);

  console.log(
    `\n  Found ${pc.bold(String(report.groups_found))} semantic group(s). ` +
      `${pc.green(String(report.groups_merged))} recommended for merge` +
      (totalRedundant > 0
        ? ` (saving ${pc.bold(String(totalRedundant))} redundant decisions).`
        : '.') +
      ` ${pc.yellow(String(report.groups_review))} for review.`,
  );

  // Detail per group
  if (groups.length > 0) {
    console.log(pc.cyan('\n  Groups:'));
    for (let i = 0; i < groups.length; i++) {
      const g = groups[i];
      const sim = (g.similarity * 100).toFixed(1);
      const actionLabel =
        g.suggestedAction === 'merge'
          ? pc.green('merge')
          : g.suggestedAction === 'review'
            ? pc.yellow('review')
            : pc.dim('keep');

      const areas = g.representative.affects?.join(', ') || 'general';
      console.log(
        `    ${i + 1}. [${actionLabel}] ${pc.bold(areas)} — ` +
          `${g.members.length} decisions, ${sim}% similarity`,
      );

      for (const m of g.members) {
        const isRep = m.id === g.representative.id;
        const label = isRep ? pc.green('*') : ' ';
        const summary = m.summary ?? m.detail.slice(0, 60);
        console.log(
          `       ${label} ${pc.dim(m.id.slice(0, 8))}... ${summary}`,
        );
      }
    }
  }

  // Applied stats
  if (report.mode === 'applied') {
    console.log(pc.dim('\n\u2500'.repeat(50)));
    console.log(`  Patterns created:      ${pc.bold(String(report.patterns_created))}`);
    console.log(`  Decisions deprecated:  ${pc.bold(String(report.decisions_deprecated))}`);
  }

  if (report.errors.length > 0) {
    console.log(pc.red('\n  Errors:'));
    for (const e of report.errors) {
      console.log(`    - Group ${e.group_index + 1}: ${e.error}`);
    }
  }

  if (report.mode === 'dry_run' && report.groups_merged > 0) {
    console.log(
      pc.yellow('\n  Run with --auto-merge to execute consolidation.'),
    );
  }
  console.log();
}

// ---------------------------------------------------------------------------
// Merge execution
// ---------------------------------------------------------------------------

async function executeGroupMerge(
  supabase: ReturnType<typeof getSupabaseClient>,
  orgId: string,
  memberId: string,
  group: SemanticGroup,
): Promise<{ patternsCreated: number; decisionsDeprecated: number }> {
  // Generate summary for the merged group
  const mergedSummary = group.mergedSummary ?? generateGroupSummary(group.members);

  // Collect all member IDs
  const memberIds = group.members.map((m) => m.id);

  // Collect union of all affects tags
  const allAffects = [
    ...new Set(group.members.flatMap((m) => m.affects ?? [])),
  ];

  // Use highest confidence from the group
  const maxConfidence = Math.max(
    ...group.members.map((m) => m.confidence ?? 0),
  );

  // Create new consolidated pattern decision
  const newDecision = await storeDecision(
    supabase,
    orgId,
    {
      text: mergedSummary,
      type: 'pattern',
      summary: `Consolidated: ${allAffects.join(', ')} (${memberIds.length} decisions merged)`,
      affects: allAffects,
      confidence: maxConfidence,
      project_id: group.representative.project_id,
    },
    'system',
    'synthesis',
    { depends_on: memberIds },
  );

  // Audit the creation
  try {
    const auditPayload = buildAuditPayload(
      'decision_consolidated',
      'decision',
      newDecision.id,
      memberId,
      orgId,
      {
        newState: {
          merged_from: memberIds,
          areas: allAffects,
          similarity: group.similarity,
        },
        reason: `Consolidated ${memberIds.length} semantically similar decisions`,
      },
    );
    await createAuditEntry(supabase, auditPayload);
  } catch {
    // Audit failures are non-fatal
  }

  // Deprecate all merged decisions
  let deprecated = 0;
  for (const member of group.members) {
    try {
      await changeDecisionStatus(
        supabase,
        orgId,
        member.id,
        'deprecated',
        memberId,
        `Consolidated into ${newDecision.id}`,
      );
      deprecated++;

      // Audit each deprecation
      try {
        const auditPayload = buildAuditPayload(
          'decision_consolidated',
          'decision',
          member.id,
          memberId,
          orgId,
          {
            previousState: { status: member.status },
            newState: {
              status: 'deprecated',
              superseded_by: newDecision.id,
            },
            reason: `Consolidated into ${newDecision.id}`,
          },
        );
        await createAuditEntry(supabase, auditPayload);
      } catch {
        // Non-fatal
      }
    } catch {
      // Individual failures don't halt the batch
    }
  }

  return { patternsCreated: 1, decisionsDeprecated: deprecated };
}

// ---------------------------------------------------------------------------
// Command handler
// ---------------------------------------------------------------------------

export async function adminConsolidateCommand(
  options: AdminConsolidateOptions,
): Promise<void> {
  const autoMerge = !!options.autoMerge;
  const threshold = options.threshold ? parseFloat(options.threshold) : 0.7;

  if (isNaN(threshold) || threshold < 0.5 || threshold > 1.0) {
    console.error('Error: --threshold must be between 0.5 and 1.0');
    process.exit(1);
  }

  const config = await loadConfig();
  const orgId = options.org || config?.org_id;

  if (!orgId) {
    console.error(
      'Error: org ID required. Use --org <org_id> or run `valis init`.',
    );
    process.exit(1);
  }

  const supabaseUrl = process.env.SUPABASE_URL || config?.supabase_url;
  const serviceRoleKey =
    process.env.SUPABASE_SERVICE_ROLE_KEY || config?.supabase_service_role_key;
  const qdrantUrl = process.env.QDRANT_URL || config?.qdrant_url;
  const qdrantApiKey = process.env.QDRANT_API_KEY || config?.qdrant_api_key;

  if (!supabaseUrl || !serviceRoleKey) {
    console.error(
      'Error: Supabase credentials required. Set env vars or run `valis init`.',
    );
    process.exit(1);
  }

  if (!qdrantUrl || !qdrantApiKey) {
    console.error(
      'Error: Qdrant credentials required. Set env vars or run `valis init`.',
    );
    process.exit(1);
  }

  const supabase = getSupabaseClient(supabaseUrl, serviceRoleKey);
  const qdrant = getQdrantClient(qdrantUrl, qdrantApiKey);
  const memberId = config?.member_id || 'system';

  try {
    console.log(
      autoMerge
        ? pc.bold('Running consolidation with auto-merge...')
        : pc.dim('Running consolidation in dry-run mode...'),
    );

    const groups = await findSemanticGroups(qdrant, supabase, orgId, {
      threshold,
      minGroupSize: 2,
    });

    const report: ConsolidationReport = {
      mode: autoMerge ? 'applied' : 'dry_run',
      groups_found: groups.length,
      groups_merged: groups.filter((g) => g.suggestedAction === 'merge').length,
      groups_review: groups.filter((g) => g.suggestedAction === 'review').length,
      groups_keep: groups.filter((g) => g.suggestedAction === 'keep').length,
      decisions_deprecated: 0,
      patterns_created: 0,
      errors: [],
    };

    // Execute merges if auto-merge is enabled
    if (autoMerge) {
      for (let i = 0; i < groups.length; i++) {
        const group = groups[i];
        if (group.suggestedAction !== 'merge') continue;

        try {
          const result = await executeGroupMerge(
            supabase,
            orgId,
            memberId,
            group,
          );
          report.patterns_created += result.patternsCreated;
          report.decisions_deprecated += result.decisionsDeprecated;
        } catch (err) {
          report.errors.push({
            group_index: i,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    formatReport(report, groups);
  } catch (err) {
    console.error(`Consolidation error: ${(err as Error).message}`);
    process.exit(1);
  }
}
