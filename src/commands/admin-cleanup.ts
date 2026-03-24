/**
 * `teamind admin cleanup` command — T025 (US3)
 *
 * Runs the dedup + orphan detection pipeline and formats a report.
 *
 * Usage:
 *   teamind admin cleanup [--dry-run | --apply] [--org <org_id>]
 *
 * --dry-run (default): Report what would be cleaned. No mutations.
 * --apply:             Execute cleanup actions. Creates audit entries.
 * --org:               Optional org filter (defaults to local config org).
 */

import pc from 'picocolors';
import { loadConfig } from '../config/store.js';
import { getSupabaseClient } from '../cloud/supabase.js';
import { getQdrantClient } from '../cloud/qdrant.js';
import { runCleanup, type CleanupOptions } from '../cleanup/runner.js';
import type { CleanupReport } from '../types.js';

export interface AdminCleanupCommandOptions {
  dryRun?: boolean;
  apply?: boolean;
  org?: string;
}

function formatReport(report: CleanupReport): void {
  const modeLabel = report.dry_run
    ? pc.yellow('DRY RUN')
    : pc.green('APPLIED');

  console.log(`\n${pc.bold('Cleanup Report')} [${modeLabel}]`);
  console.log(pc.dim('\u2500'.repeat(50)));

  // Exact duplicates
  console.log(
    `\n  ${pc.bold('Exact Duplicates')}: ${report.exact_dupes.length} group(s)`,
  );
  if (report.exact_dupes.length > 0) {
    for (const group of report.exact_dupes) {
      const depCount = group.deprecated_ids.length;
      const action = report.dry_run ? 'would deprecate' : 'deprecated';
      console.log(
        `    Keep ${pc.cyan(group.kept_id.slice(0, 8))}... — ${action} ${depCount} duplicate(s)`,
      );
      for (const depId of group.deprecated_ids) {
        console.log(`      ${pc.dim('-')} ${pc.red(depId.slice(0, 8))}...`);
      }
    }
    if (!report.dry_run) {
      console.log(
        `    ${pc.green(`Total deprecated: ${report.exact_dupes_deprecated}`)}`,
      );
    }
  }

  // Near duplicates (flagged for review)
  console.log(
    `\n  ${pc.bold('Near Duplicates')} ${pc.dim('(flagged for review)')}: ${report.near_dupes.length} pair(s)`,
  );
  if (report.near_dupes.length > 0) {
    for (const pair of report.near_dupes) {
      const sim = (pair.similarity * 100).toFixed(1);
      console.log(
        `    ${pc.cyan(pair.decision_a_id.slice(0, 8))}... ${pc.dim('<->')} ${pc.cyan(pair.decision_b_id.slice(0, 8))}... (${sim}% similar)`,
      );
    }
  }

  // Stale orphans (flagged for review)
  console.log(
    `\n  ${pc.bold('Stale Orphans')} ${pc.dim('(flagged for review)')}: ${report.orphans.length}`,
  );
  if (report.orphans.length > 0) {
    for (const orphan of report.orphans) {
      console.log(
        `    ${pc.yellow(orphan.decision_id.slice(0, 8))}... — ${orphan.age_days} days old`,
      );
    }
  }

  // Summary
  console.log(pc.dim('\n\u2500'.repeat(50)));
  const totalFindings =
    report.exact_dupes.length +
    report.near_dupes.length +
    report.orphans.length;

  if (totalFindings === 0) {
    console.log(pc.green('  No cleanup issues found.'));
  } else {
    console.log(`  Findings: ${totalFindings} total`);
    if (report.dry_run) {
      console.log(
        pc.yellow('  Run with --apply to execute cleanup actions.'),
      );
    }
  }
  console.log();
}

export async function adminCleanupCommand(
  options: AdminCleanupCommandOptions,
): Promise<void> {
  // Determine mode: --apply means apply, otherwise dry-run (default)
  const dryRun = !options.apply;

  // Resolve config
  const config = await loadConfig();
  const orgId = options.org || config?.org_id;

  if (!orgId) {
    console.error(
      'Error: org ID required. Use --org <org_id> or run `teamind init`.',
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
      'Error: Supabase credentials required. Set env vars or run `teamind init`.',
    );
    process.exit(1);
  }

  if (!qdrantUrl || !qdrantApiKey) {
    console.error(
      'Error: Qdrant credentials required. Set env vars or run `teamind init`.',
    );
    process.exit(1);
  }

  const supabase = getSupabaseClient(supabaseUrl, serviceRoleKey);
  const qdrant = getQdrantClient(qdrantUrl, qdrantApiKey);

  // Resolve member ID for audit attribution
  const memberId = config?.member_id || 'system';

  const cleanupOptions: CleanupOptions = {
    apply: !dryRun,
    orgId,
    memberId,
  };

  try {
    if (dryRun) {
      console.log(pc.dim('Running cleanup in dry-run mode...'));
    } else {
      console.log(pc.bold('Running cleanup in apply mode...'));
    }

    const report = await runCleanup(supabase, qdrant, cleanupOptions);
    formatReport(report);
  } catch (err) {
    console.error(`Cleanup error: ${(err as Error).message}`);
    process.exit(1);
  }
}
