/**
 * T064: `teamind admin patterns` command.
 *
 * Runs pattern synthesis and formats the report. Options:
 *   --window <days>       Time window for clustering (default 30)
 *   --min-cluster <n>     Minimum decisions per cluster (default 3)
 *   --dry-run             Report patterns without creating decisions
 *   --org <org_id>        Target org (defaults to local config)
 */

import pc from 'picocolors';
import { loadConfig } from '../config/store.js';
import { getSupabaseClient } from '../cloud/supabase.js';
import { runSynthesis, type SynthesisReport } from '../synthesis/runner.js';

export interface AdminPatternsOptions {
  window?: string;
  minCluster?: string;
  dryRun?: boolean;
  org?: string;
}

function formatReport(report: SynthesisReport, windowDays: number, minCluster: number): void {
  const mode = report.dry_run ? pc.yellow('[DRY RUN]') : pc.green('[APPLIED]');

  console.log(pc.bold(`\nPattern Synthesis ${mode}`));
  console.log(pc.dim('─'.repeat(50)));
  console.log(`  Window:       ${windowDays} days`);
  console.log(`  Min cluster:  ${minCluster} decisions`);
  console.log(`  Candidates:   ${report.candidates.length}`);

  if (!report.dry_run) {
    console.log(`  Created:      ${pc.green(String(report.patterns_created))}`);
    console.log(`  Deprecated:   ${pc.yellow(String(report.patterns_deprecated))}`);
  }

  if (report.candidates.length > 0) {
    console.log(pc.bold('\n  Detected Patterns:'));

    for (const candidate of report.candidates) {
      const status = candidate.already_exists
        ? pc.dim('(exists)')
        : report.dry_run
          ? pc.cyan('(new)')
          : pc.green('(created)');

      const areas = candidate.affects.map((a) => pc.cyan(a)).join(', ');
      const count = candidate.decision_ids.length;
      const cohesion = (candidate.cohesion * 100).toFixed(0);

      console.log(`\n    ${status} ${areas}`);
      console.log(`      Decisions: ${count}  |  Cohesion: ${cohesion}%`);
      console.log(
        `      IDs: ${candidate.decision_ids.map((id) => pc.dim(id.substring(0, 8))).join(', ')}`,
      );
    }
  } else {
    console.log(pc.dim('\n  No pattern clusters detected.'));
  }

  if (report.errors.length > 0) {
    console.log(pc.red(`\n  Errors (${report.errors.length}):`));
    for (const err of report.errors) {
      console.log(`    - ${pc.red(err)}`);
    }
  }

  console.log();
}

export async function adminPatternsCommand(options: AdminPatternsOptions): Promise<void> {
  const config = await loadConfig();
  if (!config) {
    console.error('Error: Teamind not configured. Run `teamind init` first.');
    process.exit(1);
  }

  const supabase = getSupabaseClient(
    config.supabase_url,
    config.supabase_service_role_key,
  );

  const orgId = options.org || config.org_id;
  const windowDays = parseInt(options.window || '30', 10) || 30;
  const minCluster = parseInt(options.minCluster || '3', 10) || 3;

  try {
    const report = await runSynthesis(supabase, orgId, {
      windowDays,
      minCluster,
      dryRun: options.dryRun ?? false,
      memberId: config.member_id ?? 'system',
    });

    formatReport(report, windowDays, minCluster);
  } catch (err) {
    console.error(`Pattern synthesis error: ${(err as Error).message}`);
    process.exit(1);
  }
}
