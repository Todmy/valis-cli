import pc from 'picocolors';
import { loadConfig } from '../config/store.js';
import { getSupabaseClient, getDashboardStats } from '../cloud/supabase.js';

export async function dashboardCommand(): Promise<void> {
  const config = await loadConfig();
  if (!config) {
    console.error('Error: Teamind not configured. Run `teamind init` first.');
    process.exit(1);
  }

  const supabase = getSupabaseClient(config.supabase_url, config.supabase_service_role_key);

  try {
    const stats = await getDashboardStats(supabase, config.org_id);

    console.log(pc.bold(`\nTeamind Dashboard — ${config.org_name}\n`));
    console.log(`  Total decisions: ${pc.bold(String(stats.total_decisions))}`);

    // By type
    console.log(pc.cyan('\n  By type:'));
    for (const [type, count] of Object.entries(stats.by_type)) {
      console.log(`    ${type}: ${count}`);
    }

    // By author
    console.log(pc.cyan('\n  By author:'));
    for (const [author, count] of Object.entries(stats.by_author)) {
      console.log(`    ${author}: ${count}`);
    }

    // Recent 5
    if (stats.recent.length > 0) {
      console.log(pc.cyan('\n  Recent:'));
      for (const d of stats.recent) {
        const summary = d.summary || d.detail.substring(0, 60);
        console.log(`    ${summary} — ${pc.dim(d.author)} — ${pc.dim(d.created_at)}`);
      }
    }

    // Pending
    if (stats.pending_count > 0) {
      console.log(pc.yellow(`\n  Pending: ${stats.pending_count} decisions awaiting classification`));
    }

    console.log();
  } catch (err) {
    console.error(`Dashboard error: ${(err as Error).message}`);
    process.exit(1);
  }
}
