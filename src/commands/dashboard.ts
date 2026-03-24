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

    // T045: Pinned count from dashboard stats
    const pinnedCount = stats.pinned_count ?? 0;

    console.log(pc.bold(`\nTeamind Dashboard — ${config.org_name}\n`));
    console.log(`  Total decisions: ${pc.bold(String(stats.total_decisions))}`);
    // T045: Show pinned count in summary
    if (pinnedCount > 0) {
      console.log(`  Pinned:          ${pc.magenta(pc.bold(String(pinnedCount)))} immune to decay`);
    }
    // T014: Show proposed count in summary if any exist
    if (stats.by_status?.proposed) {
      console.log(`  Proposed:        ${pc.blue(pc.bold(String(stats.by_status.proposed)))} awaiting review`);
    }

    // Lifecycle stats
    if (stats.by_status) {
      console.log(pc.cyan('\n  Lifecycle:'));
      console.log(`    Active:     ${pc.green(String(stats.by_status.active || 0))}`);
      console.log(`    Proposed:   ${pc.blue(String(stats.by_status.proposed || 0))}`);
      console.log(`    Deprecated: ${pc.yellow(String(stats.by_status.deprecated || 0))}`);
      console.log(`    Superseded: ${pc.dim(String(stats.by_status.superseded || 0))}`);
      console.log(`    Pinned:     ${pc.magenta(String(pinnedCount))}`);
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

    // Recent 5 — T045: mark pinned decisions visually
    if (stats.recent.length > 0) {
      console.log(pc.cyan('\n  Recent:'));
      for (const d of stats.recent) {
        const summary = d.summary || d.detail.substring(0, 60);
        const pinLabel = d.pinned ? pc.magenta(' [pinned]') : '';
        console.log(`    ${summary}${pinLabel} — ${pc.dim(d.author)} — ${pc.dim(d.created_at)}`);
      }
    }

    // T014: Proposed decisions awaiting review
    const proposedCount = stats.by_status?.proposed || 0;
    if (proposedCount > 0) {
      console.log(pc.blue(`\n  Proposed (${proposedCount}):`));
      const proposedDecisions = stats.recent.filter((d) => d.status === 'proposed');
      if (proposedDecisions.length > 0) {
        for (const d of proposedDecisions) {
          const summary = d.summary || d.detail.substring(0, 60);
          console.log(`    ${pc.blue('●')} ${summary} — ${pc.dim(d.author)} — ${pc.dim(d.created_at)}`);
        }
      } else {
        console.log(`    ${proposedCount} decision(s) awaiting review`);
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
