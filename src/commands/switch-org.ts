/**
 * `teamind switch` — Switch from community/standalone to a team org,
 * or switch between orgs. Preserves existing decisions in the old org.
 *
 * @module commands/switch-org
 */

import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import pc from 'picocolors';
import { loadConfig, saveConfig } from '../config/store.js';

async function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

export async function switchOrgCommand(options: { join: string }): Promise<void> {
  console.log(pc.bold('\n🔄 Teamind Switch Org\n'));

  const existing = await loadConfig();
  if (!existing) {
    console.log(pc.red('Teamind is not configured. Run `teamind init` first.'));
    return;
  }

  console.log(pc.dim(`Current org: ${existing.org_name} (${existing.org_id})`));
  console.log(pc.dim(`Current author: ${existing.author_name}\n`));

  const inviteCode = options.join;
  const authorName = await prompt('Your name for the new org: ');

  console.log(pc.cyan(`\nJoining org with invite code: ${inviteCode}`));

  const response = await fetch(`${existing.supabase_url}/functions/v1/join-org`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ invite_code: inviteCode, author_name: authorName }),
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(`Failed to join org: ${error.error || 'unknown error'}`);
  }

  const result = await response.json() as {
    org_id: string;
    org_name: string;
    api_key: string;
    member_api_key?: string;
    member_key?: string;
    member_id?: string;
    member_count: number;
    decision_count: number;
    role: string;
  };

  // Update config — keep infrastructure credentials, change org
  await saveConfig({
    ...existing,
    org_id: result.org_id,
    org_name: result.org_name,
    api_key: result.api_key || '',
    invite_code: inviteCode,
    author_name: authorName,
    member_id: result.member_id || null,
    member_api_key: result.member_api_key || result.member_key || null,
    auth_mode: result.member_api_key ? 'jwt' as const : existing.auth_mode,
  });

  console.log(pc.green(`\n✓ Switched to "${result.org_name}" (${result.member_count} members)`));
  console.log(`  ${result.decision_count} decisions already available`);
  console.log(pc.dim(`\n  Your previous org "${existing.org_name}" data is preserved in the cloud.`));
  console.log(`\n  Next: Restart your IDE or run ${pc.dim('teamind serve')} to connect.\n`);
}
