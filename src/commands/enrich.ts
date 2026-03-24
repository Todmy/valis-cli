/**
 * T057: `teamind enrich` command.
 *
 * Runs the LLM enrichment pipeline on pending decisions.
 * Supports --dry-run, --provider, and --ceiling flags.
 */

import pc from 'picocolors';
import { loadConfig } from '../config/store.js';
import { getSupabaseClient } from '../cloud/supabase.js';
import { getQdrantClient } from '../cloud/qdrant.js';
import { runEnrichment } from '../enrichment/runner.js';

export interface EnrichCommandOptions {
  dryRun?: boolean;
  provider?: string;
  ceiling?: string;
}

export async function enrichCommand(options: EnrichCommandOptions): Promise<void> {
  const config = await loadConfig();
  if (!config) {
    console.error('Error: Teamind not configured. Run `teamind init` first.');
    process.exit(1);
  }

  const supabase = getSupabaseClient(config.supabase_url, config.supabase_service_role_key);

  // Qdrant client (optional — enrichment can proceed without it)
  let qdrant = null;
  try {
    qdrant = getQdrantClient(config.qdrant_url, config.qdrant_api_key);
  } catch {
    // Qdrant unavailable — Postgres updates still happen
  }

  // Parse ceiling: user provides dollars, we convert to cents
  let ceilingCents: number | undefined;
  if (options.ceiling) {
    const dollars = parseFloat(options.ceiling);
    if (isNaN(dollars) || dollars <= 0) {
      console.error('Error: --ceiling must be a positive number (in dollars).');
      process.exit(1);
    }
    ceilingCents = Math.round(dollars * 100);
  }

  try {
    const report = await runEnrichment(supabase, qdrant, {
      provider: options.provider,
      dryRun: options.dryRun,
      ceilingCents,
      orgId: config.org_id,
      memberId: config.member_id ?? 'system',
    });

    // Format output
    console.log();

    if (report.mode === 'no_provider') {
      // T059: Graceful no-key-configured path
      console.log(pc.yellow(report.message));
      console.log(pc.dim('Set ANTHROPIC_API_KEY or OPENAI_API_KEY to enable enrichment.'));
      console.log();
      return;
    }

    if (report.mode === 'no_pending') {
      console.log(pc.green(report.message));
      console.log();
      return;
    }

    if (report.mode === 'dry_run') {
      console.log(pc.bold('Enrichment — Dry Run'));
      console.log(pc.dim('─'.repeat(35)));
      console.log(`  Candidates: ${pc.bold(String(report.candidates))}`);
      console.log(`  Provider:   ${pc.cyan(options.provider || 'auto-detect')}`);
      console.log(`  ${pc.dim('No changes made.')}`);
      console.log();
      return;
    }

    // Applied mode
    console.log(pc.bold('Enrichment Report'));
    console.log(pc.dim('─'.repeat(35)));
    console.log(`  Enriched:   ${pc.green(String(report.enriched))}`);
    console.log(`  Skipped:    ${report.skipped > 0 ? pc.yellow(String(report.skipped)) : String(report.skipped)}`);
    console.log(`  Total cost: ${pc.cyan('$' + (report.costCents / 100).toFixed(2))}`);
    console.log(`  Candidates: ${report.candidates}`);

    if (report.errors.length > 0) {
      console.log(pc.yellow(`\n  Errors (${report.errors.length}):`));
      for (const e of report.errors.slice(0, 5)) {
        console.log(`    ${pc.dim(e.decisionId)}: ${e.error}`);
      }
      if (report.errors.length > 5) {
        console.log(`    ${pc.dim(`...and ${report.errors.length - 5} more`)}`);
      }
    }

    if (report.message.includes('ceiling')) {
      console.log(pc.yellow(`\n  ${report.message}`));
    }

    console.log();
  } catch (err) {
    console.error(`Enrichment error: ${(err as Error).message}`);
    process.exit(1);
  }
}
