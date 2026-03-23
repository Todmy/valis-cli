import pc from 'picocolors';
import { loadConfig } from '../config/store.js';
import { computeMetrics, type PlatformMetrics } from '../metrics/compute.js';

interface AdminMetricsOptions {
  json?: boolean;
  period?: '7d' | '30d';
}

function pct(part: number, total: number): string {
  if (total === 0) return '0%';
  return `${Math.round((part / total) * 100)}%`;
}

function pad(label: string, width: number): string {
  return label.padEnd(width);
}

function formatTable(metrics: PlatformMetrics): void {
  const periodLabel = metrics.period === '7d' ? '7 days' : '30 days';

  console.log(pc.bold(`\nTeamind Metrics (last ${periodLabel})`));
  console.log(pc.dim('\u2500'.repeat(35)));

  // Org counts
  console.log(`  ${pad('Total orgs:', 22)} ${pc.bold(String(metrics.total_orgs))}`);
  console.log(
    `  ${pad('Active orgs (7d):', 22)} ${metrics.active_orgs_7d}  (${pct(metrics.active_orgs_7d, metrics.total_orgs)})`,
  );
  console.log(
    `  ${pad('Active orgs (30d):', 22)} ${metrics.active_orgs_30d}  (${pct(metrics.active_orgs_30d, metrics.total_orgs)})`,
  );

  console.log();

  // Per-org averages
  console.log(`  ${pad('Avg decisions/org:', 22)} ${metrics.avg_decisions_per_org}`);
  console.log(`  ${pad('Avg searches/org:', 22)} ${metrics.avg_searches_per_org}`);
  console.log(`  ${pad('Est. COGS/org/mo:', 22)} $${metrics.estimated_cogs_per_org.toFixed(2)}`);
  console.log(`  ${pad('Active members:', 22)} ${metrics.active_members}`);

  // Activation funnel
  console.log(pc.cyan('\n  Activation Funnel'));
  console.log(
    `    ${pad('Created:', 20)} ${metrics.activation.created}`,
  );
  console.log(
    `    ${pad('First store <24h:', 20)} ${metrics.activation.first_store_within_24h}   (${pct(metrics.activation.first_store_within_24h, metrics.activation.created)})`,
  );
  console.log(
    `    ${pad('Weekly active:', 20)} ${metrics.activation.weekly_active}   (${pct(metrics.activation.weekly_active, metrics.activation.created)})`,
  );

  // At-risk
  if (metrics.at_risk_orgs.length > 0) {
    console.log(
      pc.yellow(`\n  At-risk (30d idle): ${metrics.churned_orgs_30d}`),
    );
    for (const org of metrics.at_risk_orgs) {
      const lastDate = new Date(org.last_activity).toISOString().split('T')[0];
      console.log(
        `    - Org ${pc.dim(`"${org.org_name}"`)} (last activity: ${lastDate})`,
      );
    }
  } else {
    console.log(pc.green('\n  At-risk (30d idle): 0'));
  }

  console.log();
}

export async function adminMetricsCommand(options: AdminMetricsOptions): Promise<void> {
  const period = options.period || '7d';

  if (period !== '7d' && period !== '30d') {
    console.error('Error: --period must be 7d or 30d');
    process.exit(1);
  }

  // Resolve service_role key: env var takes priority, then config
  const envKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const config = await loadConfig();

  const serviceRoleKey = envKey || config?.supabase_service_role_key;
  const supabaseUrl = process.env.SUPABASE_URL || config?.supabase_url;

  if (!serviceRoleKey) {
    console.error(
      'Error: service_role key required. Set SUPABASE_SERVICE_ROLE_KEY env var or run `teamind init`.',
    );
    process.exit(1);
  }

  if (!supabaseUrl) {
    console.error(
      'Error: Supabase URL required. Set SUPABASE_URL env var or run `teamind init`.',
    );
    process.exit(1);
  }

  try {
    const metrics = await computeMetrics(supabaseUrl, serviceRoleKey, period);

    if (options.json) {
      console.log(JSON.stringify(metrics, null, 2));
    } else {
      formatTable(metrics);
    }
  } catch (err) {
    console.error(`Metrics error: ${(err as Error).message}`);
    process.exit(1);
  }
}
