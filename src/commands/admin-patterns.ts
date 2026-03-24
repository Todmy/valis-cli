/**
 * T064: `teamind admin patterns` command.
 *
 * Detects decision clusters by area overlap, synthesizes pattern decisions,
 * and reports results. Supports --dry-run (default), --window, and --min-cluster.
 */

import pc from 'picocolors';
import { loadConfig } from '../config/store.js';
import { getSupabaseClient } from '../cloud/supabase.js';
import { runSynthesis, type SynthesisReport } from '../synthesis/runner.js';

export interface AdminPatternsOptions {
  window?: string;
  minCluster?: string;
  dryRun?: boolean;
}

function formatReport(report: SynthesisReport): void {
  const modeLabel = report.mode === 'dry_run' ? pc.yellow('DRY RUN') : pc.green('APPLIED');

  console.log(pc.bold(`\nPattern Synthesis ${modeLabel}`));
  console.log(pc.dim('\u2500'.repeat(40)));

  console.log(`  Candidates detected:    ${pc.bold(String(report.candidates_detected))}`);
  console.log(`  Patterns created:       ${pc.bold(String(report.patterns_created))}`);
  console.log(`  Skipped (idempotent):   ${pc.bold(String(report.patterns_skipped_idempotent))}`);
  console.log(`  Stale deprecated:       ${pc.bold(String(report.stale_patterns_deprecated))}`);

  if (report.candidates.length > 0) {
    console.log(pc.cyan('\n  Candidates:'));
    for (const c of report.candidates) {
      const status = c.already_exists
        ? pc.dim(' (exists)')
        : report.mode === 'dry_run'
          ? pc.yellow(' (would create)')
          : pc.green(' (created)');
      console.log(
        `    - ${pc.bold(c.affects.join(', '))} — ${c.decision_ids.length} decisions, ` +
          `cohesion ${c.cohesion.toFixed(2)}${status}`,
      );
    }
  }

  if (report.errors.length > 0) {
    console.log(pc.red('\n  Errors:'));
    for (const e of report.errors) {
      console.log(`    - ${e.area}: ${e.error}`);
    }
  }

  console.log();
}

export async function adminPatternsCommand(options: AdminPatternsOptions): Promise<void> {
  const windowDays = options.window ? parseInt(options.window, 10) : 30;
  const minCluster = options.minCluster ? parseInt(options.minCluster, 10) : 3;
  const dryRun = options.dryRun !== false; // default to dry-run

  if (isNaN(windowDays) || windowDays < 1) {
    console.error('Error: --window must be a positive integer (days)');
    process.exit(1);
  }

  if (isNaN(minCluster) || minCluster < 2) {
    console.error('Error: --min-cluster must be at least 2');
    process.exit(1);
  }

  const config = await loadConfig();
  if (!config) {
    console.error('Error: Not configured. Run `teamind init` first.');
    process.exit(1);
  }

  try {
    const supabase = getSupabaseClient(config.supabase_url, config.supabase_service_role_key);

    const report = await runSynthesis(supabase, {
      orgId: config.org_id,
      windowDays,
      minCluster,
      dryRun,
      memberId: config.member_id ?? undefined,
    });

    formatReport(report);
  } catch (err) {
    console.error(`Synthesis error: ${(err as Error).message}`);
    process.exit(1);
  }
}
