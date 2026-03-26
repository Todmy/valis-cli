/**
 * T057 + T033: `valis enrich` command.
 *
 * Hosted mode (auth_mode=jwt): calls /api/enrich on the server, which uses
 * the server-side ANTHROPIC_API_KEY. No local LLM key required.
 *
 * Community mode: runs the local LLM enrichment pipeline using the user's
 * own ANTHROPIC_API_KEY or OPENAI_API_KEY.
 *
 * Options:
 *   --dry-run      Show what would be enriched (no mutations, no LLM calls).
 *   --provider     Override configured LLM provider (anthropic|openai). Community only.
 *   --ceiling      Override daily cost ceiling in dollars (default $1.00). Community only.
 *
 * @module commands/enrich
 */

import pc from 'picocolors';
import { loadConfig } from '../config/store.js';
import { getSupabaseClient } from '../cloud/supabase.js';
import { getQdrantClient } from '../cloud/qdrant.js';
import { runEnrichment, type EnrichmentReport } from '../enrichment/runner.js';
import { isHostedMode, resolveApiUrl, resolveApiPath } from '../cloud/api-url.js';
import { getToken } from '../auth/jwt.js';
import { HOSTED_SUPABASE_URL } from '../types.js';

export interface EnrichCommandOptions {
  dryRun?: boolean;
  provider?: string;
  ceiling?: string;
}

// ---------------------------------------------------------------------------
// Hosted enrichment response shape (matches /api/enrich contract)
// ---------------------------------------------------------------------------

interface HostedEnrichResponse {
  enriched: Array<{
    decision_id: string;
    type: string;
    summary: string;
    affects: string[];
    confidence: number;
    tokens_used: number;
    cost_cents: number;
  }>;
  skipped: string[];
  total_cost_cents: number;
  daily_budget_remaining_cents: number;
  auto_discovered?: boolean;
}

// ---------------------------------------------------------------------------
// Main command
// ---------------------------------------------------------------------------

export async function enrichCommand(options: EnrichCommandOptions): Promise<void> {
  const config = await loadConfig();
  if (!config) {
    console.error('Error: Valis not configured. Run `valis init` first.');
    process.exit(1);
  }

  const dryRun = options.dryRun ?? false;

  // Hosted mode: delegate to /api/enrich
  if (config.auth_mode === 'jwt' && isHostedMode(config)) {
    await runHostedEnrichment(config, dryRun);
    return;
  }

  // Community mode: local enrichment
  await runCommunityEnrichment(config, options);
}

// ---------------------------------------------------------------------------
// Hosted enrichment — calls /api/enrich
// ---------------------------------------------------------------------------

async function runHostedEnrichment(
  config: import('../types.js').ValisConfig,
  dryRun: boolean,
): Promise<void> {
  console.log(
    pc.bold(
      `\nValis Enrichment — ${dryRun ? pc.yellow('DRY RUN') : pc.cyan('HOSTED')}\n`,
    ),
  );
  console.log(`  Org: ${config.org_id}`);
  console.log(`  Mode: ${pc.cyan('hosted')} (server-side enrichment)`);
  console.log();

  if (dryRun) {
    console.log(
      pc.yellow(
        '  Dry-run not supported for hosted enrichment.\n' +
          '  The server processes decisions directly — omit --dry-run to enrich.\n',
      ),
    );
    return;
  }

  // Get JWT token via exchangeToken
  const apiKey = config.member_api_key ?? config.api_key;
  const projectId = config.project_id ?? undefined;
  const tokenCache = await getToken(config.supabase_url, apiKey, projectId);

  if (!tokenCache) {
    console.error(
      'Error: Could not obtain auth token. Run `valis init` to re-authenticate.',
    );
    process.exit(1);
  }

  console.log('  Auto-discovering unenriched decisions on server...\n');

  // Call hosted /api/enrich with auto-discovery (server finds pending decisions)
  const isHosted = config.supabase_url.replace(/\/$/, '') === HOSTED_SUPABASE_URL;
  const apiUrl = resolveApiUrl(config.supabase_url, isHosted);
  const enrichUrl = resolveApiPath(apiUrl, 'enrich');

  let res: Response;
  try {
    res = await fetch(enrichUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tokenCache.jwt.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ auto: true }),
    });
  } catch (err) {
    console.error(
      `Error: Network failure calling hosted enrichment: ${(err as Error).message}`,
    );
    process.exit(1);
  }

  if (!res.ok) {
    let errorBody = '';
    try {
      errorBody = await res.text();
    } catch {
      // ignore
    }

    if (res.status === 401) {
      console.error('Error: Authentication failed. Run `valis init` to re-authenticate.');
    } else if (res.status === 403) {
      console.error(
        'Error: Hosted enrichment not available for your account. ' +
          'Community users should set ANTHROPIC_API_KEY locally.',
      );
    } else if (res.status === 429) {
      console.error('Error: Daily enrichment budget exceeded. Try again tomorrow.');
    } else if (res.status === 503) {
      console.error('Error: Server-side enrichment is temporarily unavailable.');
    } else {
      console.error(`Error: Hosted enrichment failed (HTTP ${res.status}): ${errorBody}`);
    }
    process.exit(1);
  }

  let result: HostedEnrichResponse;
  try {
    result = (await res.json()) as HostedEnrichResponse;
  } catch (err) {
    console.error(`Error: Could not parse enrichment response: ${(err as Error).message}`);
    process.exit(1);
  }

  // No decisions found
  if (result.enriched.length === 0 && result.skipped.length === 0) {
    console.log(pc.green('  No pending decisions to enrich.\n'));
    return;
  }

  // Print results
  if (result.enriched.length > 0) {
    console.log(pc.cyan('  Enriched Decisions:'));
    for (const detail of result.enriched) {
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

  console.log(pc.bold('  Summary:'));
  console.log(`    Mode:        ${pc.cyan('hosted')}`);
  console.log(`    Enriched:    ${pc.green(String(result.enriched.length))}`);
  if (result.skipped.length > 0) {
    console.log(`    Skipped:     ${pc.yellow(String(result.skipped.length))}`);
  }
  console.log(
    `    Cost:        $${(result.total_cost_cents / 100).toFixed(4)}`,
  );
  console.log(
    `    Budget left: $${(result.daily_budget_remaining_cents / 100).toFixed(2)}/day`,
  );
  console.log();
}

// ---------------------------------------------------------------------------
// Community enrichment — local LLM pipeline
// ---------------------------------------------------------------------------

async function runCommunityEnrichment(
  config: import('../types.js').ValisConfig,
  options: EnrichCommandOptions,
): Promise<void> {
  const orgId = config.org_id;
  const memberId = config.member_id ?? 'system';
  const dryRun = options.dryRun ?? false;

  // Parse provider option
  let provider: 'anthropic' | 'openai' | undefined;
  if (options.provider) {
    if (options.provider !== 'anthropic' && options.provider !== 'openai') {
      console.error(
        `Error: Invalid provider "${options.provider}". Use "anthropic" or "openai".`,
      );
      process.exit(1);
    }
    provider = options.provider;
  }

  // Parse ceiling (dollars -> cents)
  let ceilingCents: number | undefined;
  if (options.ceiling) {
    const dollars = parseFloat(options.ceiling);
    if (isNaN(dollars) || dollars <= 0) {
      console.error(
        `Error: Invalid ceiling "${options.ceiling}". Use a positive number (e.g., 1.00).`,
      );
      process.exit(1);
    }
    ceilingCents = Math.round(dollars * 100);
  }

  const supabase = getSupabaseClient(
    config.supabase_url,
    config.supabase_service_role_key,
  );
  const qdrant = getQdrantClient(config.qdrant_url, config.qdrant_api_key);

  console.log(
    pc.bold(
      `\nValis Enrichment — ${dryRun ? pc.yellow('DRY RUN') : pc.cyan('ENRICH')}\n`,
    ),
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
// Formatted output (community mode)
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
