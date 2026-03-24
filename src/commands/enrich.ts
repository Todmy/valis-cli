/**
 * T057: `teamind enrich` command.
 *
 * Runs the LLM enrichment pipeline on pending decisions:
 *   --dry-run      Show what would be enriched (no mutations, no LLM calls).
 *   --provider     Override configured LLM provider (anthropic|openai).
 *   --ceiling      Override daily cost ceiling in dollars (default $1.00).
 *
 * Gracefully exits when no LLM API key is set — core operations are
 * never affected.
 *
 * @module commands/enrich
 */

import pc from 'picocolors';
import { loadConfig } from '../config/store.js';
import { getSupabaseClient } from '../cloud/supabase.js';
import { getQdrantClient } from '../cloud/qdrant.js';
import { runEnrichment, type EnrichmentReport } from '../enrichment/runner.js';

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

  const orgId = config.org_id;
  const memberId = config.member_id ?? 'system';
  const dryRun = options.dryRun ?? false;

  // Parse provider option
  let provider: 'anthropic' | 'openai' | undefined;
  if (options.provider) {
    if (options.provider !== 'anthropic' && options.provider !== 'openai') {
      console.error(`Error: Invalid provider "${options.provider}". Use "anthropic" or "openai".`);
      process.exit(1);
    }
    provider = options.provider;
  }

  // Parse ceiling (dollars -> cents)
  let ceilingCents: number | undefined;
  if (options.ceiling) {
    const dollars = parseFloat(options.ceiling);
    if (isNaN(dollars) || dollars <= 0) {
      console.error(`Error: Invalid ceiling "${options.ceiling}". Use a positive number (e.g., 1.00).`);
      process.exit(1);
    }
    ceilingCents = Math.round(dollars * 100);
  }

  const supabase = getSupabaseClient(config.supabase_url, config.supabase_service_role_key);
  const qdrant = getQdrantClient(config.qdrant_url, config.qdrant_api_key);

  console.log(
    pc.bold(`\nTeamind Enrichment — ${dryRun ? pc.yellow('DRY RUN') : pc.cyan('ENRICH')}\n`),
  );
  console.log(`  Org: ${orgId}`);
  if (provider) {
    console.log(`  Provider: ${provider}`);
  }
  if (ceilingCents) {
    console.log(`  Ceiling: $${(ceilingCents / 100).toFixed(2)}/day`);
  }
  console.log();

  try {
    const report = await runEnrichment(supabase, qdrant, {
      orgId,
      memberId,
      dryRun,
      provider,
      ceilingCents,
    });

    printReport(report);
  } catch (err) {
    console.error(`Enrichment error: ${(err as Error).message}`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Formatted output
// ---------------------------------------------------------------------------

function printReport(report: EnrichmentReport): void {
  // No provider configured
  if (report.mode === 'no_provider') {
    console.log(pc.yellow(`  ${report.message}`));
    console.log();
    console.log(pc.dim('  To configure:'));
    console.log(pc.dim('    export ANTHROPIC_API_KEY=sk-ant-...'));
    console.log(pc.dim('    export OPENAI_API_KEY=sk-...'));
    console.log();
    return;
  }

  // Dry-run mode
  if (report.mode === 'dry_run') {
    console.log(pc.cyan(`  Candidates: ${report.candidates} pending decision(s)`));
    console.log();
    console.log(pc.yellow(`  ${report.message}`));
    console.log();
    return;
  }

  // Applied mode — show details
  if (report.details.length > 0) {
    console.log(pc.cyan('  Enriched Decisions:'));
    for (const detail of report.details) {
      const id = detail.decision_id.substring(0, 8);
      console.log(
        `    ${pc.green(id)}  ${pc.bold(detail.type)}  "${detail.summary}"`,
      );
      if (detail.affects.length > 0) {
        console.log(
          `    ${' '.repeat(8)}  affects: ${detail.affects.join(', ')}`,
        );
      }
      console.log(
        `    ${' '.repeat(8)}  ${pc.dim(`${detail.tokens_used} tokens, $${(detail.cost_cents / 100).toFixed(4)}`)}`,
      );
    }
    console.log();
  }

  // Summary
  console.log(pc.bold('  Summary:'));
  console.log(`    Mode:        ${pc.green('applied')}`);
  console.log(`    Enriched:    ${pc.green(String(report.enriched))}`);
  if (report.failed > 0) {
    console.log(`    Failed:      ${pc.red(String(report.failed))}`);
  }
  console.log(`    Candidates:  ${report.candidates}`);
  if (report.remaining > 0) {
    console.log(`    Remaining:   ${pc.yellow(String(report.remaining))}`);
  }
  console.log();
  console.log(`  ${report.message}`);
  console.log();
}
