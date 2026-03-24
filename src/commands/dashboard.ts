import pc from 'picocolors';
import { loadConfig } from '../config/store.js';
import { getSupabaseClient, getDashboardStats, getProposedDecisions } from '../cloud/supabase.js';

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

    // Lifecycle stats
    if (stats.by_status) {
      const proposedCount = stats.by_status.proposed || 0;
      console.log(pc.cyan('\n  Lifecycle:'));
      console.log(`    Active:     ${pc.green(String(stats.by_status.active || 0))}`);
      console.log(`    Proposed:   ${pc.blue(String(proposedCount))}`);
      console.log(`    Deprecated: ${pc.yellow(String(stats.by_status.deprecated || 0))}`);
      console.log(`    Superseded: ${pc.dim(String(stats.by_status.superseded || 0))}`);
    }

    // T014: Proposed decisions section — list decisions awaiting review
    const proposedDecisions = await getProposedDecisions(supabase, config.org_id);
    if (proposedDecisions.length > 0) {
      console.log(pc.magenta(`\n  Proposed (${proposedDecisions.length}):`));
      for (const d of proposedDecisions) {
        const summary = d.summary || d.detail.substring(0, 60);
        console.log(
          `    ${pc.blue('[proposed]')} ${summary} — ${pc.dim(d.author)} — ${pc.dim(d.created_at)}`,
        );
      }
    }

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
        // T014: Show proposed label on recent decisions that are proposed
        const statusTag = d.status === 'proposed' ? `${pc.blue('[proposed]')} ` : '';
        console.log(`    ${statusTag}${summary} — ${pc.dim(d.author)} — ${pc.dim(d.created_at)}`);
      }
    }

    // Pending
    if (stats.pending_count > 0) {
      console.log(pc.yellow(`\n  Pending: ${stats.pending_count} decisions awaiting classification`));
    }

    // Dependency warnings
    if (stats.dependency_warnings && stats.dependency_warnings.length > 0) {
      console.log(pc.red(`\n  Dependency Warnings (${stats.dependency_warnings.length}):`));
      for (const w of stats.dependency_warnings) {
        const statusLabel = w.dependency_status === 'superseded'
          ? pc.dim('superseded')
          : pc.yellow('deprecated');
        console.log(
          `    ${pc.bold(w.decision_summary)} depends on ${statusLabel} decision: ${w.dependency_summary}`,
        );
      }
    }

    console.log();
  } catch (err) {
    console.error(`Dashboard error: ${(err as Error).message}`);
    process.exit(1);
  }
}
