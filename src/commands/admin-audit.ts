import pc from 'picocolors';
import { loadConfig } from '../config/store.js';
import { getSupabaseClient, getOrgInfo } from '../cloud/supabase.js';

interface AuditRow {
  id: string;
  org_id: string;
  member_id: string;
  action: string;
  target_type: string;
  target_id: string;
  previous_state: Record<string, unknown> | null;
  new_state: Record<string, unknown> | null;
  reason: string | null;
  created_at: string;
}

interface AuditQueryOptions {
  org?: string;
  member?: string;
  limit?: string;
}

/**
 * valis admin audit — display the audit trail for an org.
 *
 * Options:
 *   --org ORG_ID     Target org (defaults to local config org)
 *   --member AUTHOR  Filter by member/author name
 *   --limit N        Max rows (default 50)
 */
export async function adminAuditCommand(options: AuditQueryOptions): Promise<void> {
  const config = await loadConfig();
  if (!config) {
    console.error('Error: Valis not configured. Run `valis init` first.');
    process.exit(1);
  }

  const supabase = getSupabaseClient(config.supabase_url, config.supabase_service_role_key);

  const orgId = options.org || config.org_id;
  const limit = Math.min(parseInt(options.limit || '50', 10) || 50, 500);

  // Resolve org name for header
  const orgInfo = await getOrgInfo(supabase, orgId);
  const orgName = orgInfo?.name || orgId;

  // Build query
  let query = supabase
    .from('audit_log')
    .select('*')
    .eq('org_id', orgId)
    .order('created_at', { ascending: false })
    .limit(limit);

  // If --member is given, look up member IDs matching that author_name
  if (options.member) {
    const { data: members } = await supabase
      .from('members')
      .select('id')
      .eq('org_id', orgId)
      .ilike('author_name', `%${options.member}%`);

    if (!members || members.length === 0) {
      console.log(pc.yellow(`No members matching "${options.member}" found.`));
      return;
    }

    const memberIds = members.map((m: { id: string }) => m.id);
    query = query.in('member_id', memberIds);
  }

  const { data: rows, error } = await query;

  if (error) {
    console.error(`Error fetching audit log: ${error.message}`);
    process.exit(1);
  }

  const entries = (rows || []) as AuditRow[];

  if (entries.length === 0) {
    console.log(pc.yellow('\nNo audit entries found.\n'));
    return;
  }

  // Build a member-id-to-name lookup for display
  const memberIds = [...new Set(entries.map((e) => e.member_id))];
  const { data: memberRows } = await supabase
    .from('members')
    .select('id, author_name')
    .in('id', memberIds);

  const memberNameMap: Record<string, string> = {};
  for (const m of memberRows || []) {
    memberNameMap[m.id] = m.author_name;
  }

  // Print header
  console.log(pc.bold(`\nAudit Trail — ${orgName}`));
  console.log('─'.repeat(60));

  // Print rows
  for (const entry of entries) {
    const ts = formatTimestamp(entry.created_at);
    const who = memberNameMap[entry.member_id] || entry.member_id.substring(0, 8);
    const action = formatAction(entry.action);
    const target = formatTarget(entry);

    console.log(`${pc.dim(ts)}  ${pc.cyan(padRight(who, 12))} ${action}  ${target}`);

    // Show reason from new_state or previous_state
    const reason =
      entry.reason ||
      (entry.new_state as Record<string, unknown> | null)?.reason;
    if (reason) {
      console.log(`${' '.repeat(18)}${pc.dim(`reason: "${reason}"`)}`);
    }
  }

  console.log();
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  const date = d.toISOString().substring(0, 10);
  const time = d.toISOString().substring(11, 16);
  return `${date} ${time}`;
}

function padRight(s: string, len: number): string {
  return s.length >= len ? s.substring(0, len) : s + ' '.repeat(len - s.length);
}

function formatAction(action: string): string {
  const map: Record<string, string> = {
    decision_stored: pc.green('decision_stored'),
    decision_deprecated: pc.yellow('decision_deprecated'),
    decision_superseded: pc.yellow('decision_superseded'),
    decision_promoted: pc.green('decision_promoted'),
    decision_depends_added: pc.dim('decision_depends_added'),
    member_joined: pc.blue('member_joined'),
    member_revoked: pc.red('member_revoked'),
    key_rotated: pc.magenta('key_rotated'),
    org_key_rotated: pc.magenta('org_key_rotated'),
    contradiction_detected: pc.yellow('contradiction_detected'),
    contradiction_resolved: pc.green('contradiction_resolved'),
  };
  return padRight(map[action] || action, 24);
}

function formatTarget(entry: AuditRow): string {
  const id = entry.target_id.substring(0, 8);
  const newState = entry.new_state as Record<string, unknown> | null;
  const summary = newState?.summary || newState?.author_name || '';

  if (entry.target_type === 'decision') {
    return `#${id} ${summary ? `"${summary}"` : ''}`;
  }
  if (entry.target_type === 'member') {
    return summary ? `${summary}` : `member:${id}`;
  }
  if (entry.target_type === 'org') {
    return `org:${id}`;
  }
  return `${entry.target_type}:${id}`;
}
