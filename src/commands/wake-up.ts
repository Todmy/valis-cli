import pc from 'picocolors';
import { resolveConfig } from '../config/project.js';
import { getSupabaseClient, getSupabaseJwtClient } from '../cloud/supabase.js';

export async function wakeUpCommand(): Promise<void> {
  const resolved = await resolveConfig();
  const config = resolved.global;
  const projectConfig = resolved.project;

  if (!config) {
    console.log(pc.red('Not configured. Run `valis init` first.'));
    process.exit(1);
  }

  const projectName = projectConfig?.project_name ?? 'default';
  const projectId = projectConfig?.project_id;
  const orgId = config.org_id;

  console.log(pc.bold(`\nValis Wake-up — project "${projectName}"\n`));

  // Use JWT client for hosted mode, service role for community mode
  const supabase = config.auth_mode === 'jwt'
    ? getSupabaseJwtClient(config.supabase_url, config.member_api_key || config.api_key)
    : getSupabaseClient(config.supabase_url, config.supabase_service_role_key);

  // Recent decisions (last 7 days)
  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

  try {
    let query = supabase
      .from('decisions')
      .select('id, summary, status, created_at')
      .eq('org_id', orgId)
      .gte('created_at', sevenDaysAgo.toISOString())
      .order('created_at', { ascending: false })
      .limit(10);

    if (projectId) {
      query = query.eq('project_id', projectId);
    }

    const { data: decisions, error: decError } = await query;

    if (decError) {
      console.log(pc.red(`  Error fetching decisions: ${decError.message}`));
    } else if (!decisions || decisions.length === 0) {
      console.log(pc.dim('  No activity yet — start by having your agent make decisions in this project.\n'));
      return;
    } else {
      console.log('Recent decisions (last 7 days):');
      for (const d of decisions) {
        const ago = formatTimeAgo(new Date(d.created_at));
        const statusColor = d.status === 'active' ? pc.green : d.status === 'proposed' ? pc.yellow : pc.dim;
        console.log(`  • [${statusColor(d.status)}] ${d.summary || '(no summary)'} (${ago})`);
      }
    }

    // Open contradictions
    let contradictionQuery = supabase
      .from('contradictions')
      .select('id', { count: 'exact', head: true })
      .eq('org_id', orgId)
      .eq('status', 'open');

    if (projectId) {
      contradictionQuery = contradictionQuery.eq('project_id', projectId);
    }

    const { count: contradictions } = await contradictionQuery;

    console.log(`\nOpen contradictions: ${contradictions ?? 0}`);

    // Last activity
    if (decisions && decisions.length > 0) {
      const lastDate = new Date(decisions[0].created_at);
      console.log(`Last activity: ${lastDate.toISOString().replace('T', ' ').substring(0, 19)} UTC`);
    }

    console.log(pc.dim('\nRun `valis search <query>` to find specific decisions.\n'));
  } catch (err) {
    console.log(pc.red(`Error: ${(err as Error).message}`));
    process.exit(1);
  }
}

function formatTimeAgo(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
