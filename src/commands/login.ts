import password from '@inquirer/password';
import pc from 'picocolors';
import { saveCredentials, loadCredentials } from '../config/credentials.js';
import { HOSTED_API_URL, HOSTED_SUPABASE_URL } from '../types.js';
import type { ExchangeTokenResponse } from '../types.js';
import { openBrowser } from '../utils/open-browser.js';

interface DeviceCodeResponse {
  user_code: string;
  device_code: string;
  verification_url: string;
  expires_in: number;
  interval: number;
}

interface DeviceAuthResponse {
  member_api_key: string;
  member_id: string;
  author_name: string;
  org_id: string;
  org_name: string;
  supabase_url: string;
  qdrant_url: string;
  qdrant_api_key: string;
}

/**
 * Core login logic. Returns true if login succeeded.
 * Used by both `valis login` command and `valis init` (when not logged in).
 */
export async function runLogin(): Promise<boolean> {
  try {
    await loginCommand({});
    const creds = await loadCredentials();
    return !!creds;
  } catch {
    return false;
  }
}

export async function loginCommand(options: { apiKey?: boolean }): Promise<void> {
  const existing = await loadCredentials();
  if (existing) {
    console.log(pc.yellow(`Already logged in as ${existing.author_name} (${existing.org_name}).`));
    console.log(pc.dim('Run `valis logout` first to switch accounts.'));
    return;
  }

  if (options.apiKey) {
    return loginWithApiKey();
  }

  return loginWithDevice();
}

/** Device Authorization Grant flow (default) */
async function loginWithDevice(): Promise<void> {
  // 1. Request device code
  console.log(pc.cyan('Requesting device code...'));

  let deviceCode: DeviceCodeResponse;
  try {
    const res = await fetch(`${HOSTED_API_URL}/api/device-code`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });

    if (res.status === 429) {
      console.log(pc.red('Too many login attempts. Please wait a few minutes and try again.'));
      return;
    }

    if (!res.ok) {
      console.log(pc.red('Failed to generate device code. Try again later.'));
      return;
    }

    deviceCode = (await res.json()) as DeviceCodeResponse;
  } catch {
    console.log(pc.red('Cannot reach Valis Cloud. Check your internet connection.'));
    return;
  }

  // 2. Open browser + show code
  const opened = await openBrowser(deviceCode.verification_url);

  console.log(pc.bold('\nOpening browser for authentication...'));
  if (!opened) {
    console.log(pc.yellow('  Could not open browser automatically.'));
  }
  console.log(`  URL:  ${pc.cyan(deviceCode.verification_url)}`);
  console.log(`  Code: ${pc.bold(pc.green(deviceCode.user_code))}`);
  console.log(pc.dim('\nWaiting for approval... (press Ctrl+C to cancel)\n'));

  // 3. Poll for approval
  const startTime = Date.now();
  const timeout = deviceCode.expires_in * 1000;
  const interval = (deviceCode.interval || 5) * 1000;

  while (Date.now() - startTime < timeout) {
    await new Promise((r) => setTimeout(r, interval));

    try {
      const res = await fetch(`${HOSTED_API_URL}/api/device-authorize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ device_code: deviceCode.device_code }),
      });

      if (res.status === 200) {
        const auth = (await res.json()) as DeviceAuthResponse;

        await saveCredentials({
          member_api_key: auth.member_api_key,
          member_id: auth.member_id,
          author_name: auth.author_name,
          org_id: auth.org_id,
          org_name: auth.org_name,
          supabase_url: auth.supabase_url || HOSTED_SUPABASE_URL,
          qdrant_url: auth.qdrant_url || '',
        });

        console.log(pc.green(`✓ Logged in as ${auth.author_name} (${auth.org_name})`));
        console.log(pc.dim(`\n  Next: cd <project-dir> && valis init`));
        return;
      }

      if (res.status === 202) {
        process.stdout.write('.');
        continue;
      }

      if (res.status === 410) {
        console.log(pc.red('\nDevice code expired. Run `valis login` again.'));
        return;
      }

      if (res.status === 403) {
        console.log(pc.red('\nLogin denied from dashboard.'));
        return;
      }
    } catch {
      // Network error — continue polling
      process.stdout.write('x');
    }
  }

  console.log(pc.red('\nLogin timed out. Run `valis login` again.'));
}

/** API key login (fallback, --api-key flag) */
async function loginWithApiKey(): Promise<void> {
  const apiKey = await password({
    message: 'Enter your member API key (tmm_...):',
    mask: '*',
  });

  if (!apiKey || !apiKey.startsWith('tmm_')) {
    console.log(pc.red('Invalid API key format. Member API keys start with tmm_.'));
    return;
  }

  console.log(pc.cyan('\nValidating API key...'));

  const exchangeUrl = `${HOSTED_API_URL}/api/exchange-token`;

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

    const result = (await response.json()) as ExchangeTokenResponse;

    await saveCredentials({
      member_api_key: apiKey,
      member_id: result.member_id,
      author_name: result.author_name,
      org_id: result.org_id,
      org_name: result.org_name,
      supabase_url: HOSTED_SUPABASE_URL,
      qdrant_url: '',
    });

    console.log(pc.green(`\n✓ Logged in as ${result.author_name} (${result.org_name})`));
  } catch {
    console.log(pc.red('Cannot reach Valis Cloud. Check your internet connection.'));
  }
}
