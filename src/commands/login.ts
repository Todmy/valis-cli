import password from '@inquirer/password';
import pc from 'picocolors';
import { saveCredentials, loadCredentials } from '../config/credentials.js';
import { HOSTED_API_URL, HOSTED_SUPABASE_URL } from '../types.js';
import type { ExchangeTokenResponse } from '../types.js';

/**
 * Decode the payload of a JWT without verifying its signature.
 * We only need the claims for display — the server already validated the key.
 */
function decodeJwtPayload(token: string): Record<string, unknown> {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Invalid JWT format');
  // Base64url → Base64 → Buffer → JSON
  const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
  const json = Buffer.from(base64, 'base64').toString('utf-8');
  return JSON.parse(json);
}

export async function loginCommand(): Promise<void> {
  const existing = await loadCredentials();
  if (existing) {
    console.log(pc.yellow(`Already logged in as ${existing.author_name} (${existing.org_name}).`));
    console.log(pc.dim('Run `valis logout` first to switch accounts.'));
    return;
  }

  const apiKey = await password({
    message: 'Enter your member API key (tmm_...):',
    mask: '*',
  });

  if (!apiKey || !apiKey.startsWith('tmm_')) {
    console.log(pc.red('Invalid API key format. Member API keys start with tmm_.'));
    return;
  }

  // Exchange the API key for a JWT to validate it
  console.log(pc.cyan('\nValidating API key...'));

  const exchangeUrl = `${HOSTED_API_URL}/api/exchange-token`;
  let exchangeResult: ExchangeTokenResponse;

  try {
    const response = await fetch(exchangeUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
    });

    if (!response.ok) {
      if (response.status === 401) {
        console.log(pc.red('Invalid API key. Check your key and try again.'));
        return;
      }
      const body = await response.json().catch(() => ({ error: 'unknown' }));
      console.log(pc.red(`Authentication failed: ${(body as Record<string, string>).error || 'unknown error'}`));
      return;
    }

    exchangeResult = (await response.json()) as ExchangeTokenResponse;
  } catch {
    console.log(pc.red('Cannot reach Valis Cloud. Check your internet connection.'));
    return;
  }

  // Extract info from the exchange response (already has everything we need)
  const { member_id, org_id, org_name, author_name } = exchangeResult;

  // Save credentials
  await saveCredentials({
    member_api_key: apiKey,
    member_id,
    author_name,
    org_id,
    org_name,
    supabase_url: HOSTED_SUPABASE_URL,
    qdrant_url: '', // not needed for hosted mode — search goes through API proxy
  });

  console.log(pc.green(`\n✓ Logged in as ${author_name} (${org_name})`));

  // List available projects
  console.log(pc.cyan('\nFetching projects...'));
  try {
    // Use the JWT to query projects via Supabase
    const { createClient } = await import('@supabase/supabase-js');
    const supabase = createClient(HOSTED_SUPABASE_URL, 'placeholder', {
      auth: { persistSession: false, autoRefreshToken: false },
      global: {
        headers: { Authorization: `Bearer ${exchangeResult.token}` },
      },
    });

    const { data: memberships } = await supabase
      .from('project_members')
      .select('project_id, role, projects(id, name)')
      .eq('member_id', member_id);

    if (memberships && memberships.length > 0) {
      console.log(pc.bold('\nYour projects:'));
      for (const pm of memberships) {
        const project = pm.projects as unknown as { id: string; name: string } | null;
        if (project) {
          console.log(`  ${pc.cyan(project.name)} (${pm.role})`);
        }
      }
    } else {
      console.log(pc.dim('  No projects found. Run `valis init` in a project directory.'));
    }
  } catch {
    console.log(pc.dim('  Could not fetch projects. Run `valis init` in a project directory.'));
  }

  console.log(`\n  Next: ${pc.dim('cd <project-dir> && valis init')}`);
}
