import pc from 'picocolors';
import { loadConfig } from '../config/store.js';
import { getToken } from '../auth/jwt.js';
import { PLAN_PRICES } from '../billing/limits.js';
import type { PlanTier } from '../types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UpgradeOptions {
  plan?: 'team' | 'business';
  annual?: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Open a URL in the user's default browser.
 * Falls back to logging the URL if the open command fails.
 */
async function openInBrowser(url: string): Promise<void> {
  const { exec } = await import('node:child_process');
  const { platform } = await import('node:os');

  const os = platform();
  const cmd =
    os === 'darwin'
      ? `open "${url}"`
      : os === 'win32'
        ? `start "${url}"`
        : `xdg-open "${url}"`;

  return new Promise((resolve) => {
    exec(cmd, (err) => {
      if (err) {
        // Cannot open browser — just log the URL
        console.log(pc.yellow('Could not open browser automatically.'));
        console.log(`Open this URL manually: ${url}`);
      }
      resolve();
    });
  });
}

// ---------------------------------------------------------------------------
// Main command
// ---------------------------------------------------------------------------

export async function upgradeCommand(options: UpgradeOptions): Promise<void> {
  const config = await loadConfig();
  if (!config) {
    console.error(pc.red('Error: Teamind not configured. Run `teamind init` first.'));
    process.exit(1);
  }

  const plan: 'team' | 'business' = options.plan ?? 'team';
  const billingCycle = options.annual ? 'annual' : 'monthly';

  // Display plan info
  const prices = PLAN_PRICES[plan as Exclude<PlanTier, 'free'>];
  if (prices) {
    const price = billingCycle === 'annual'
      ? `$${(prices.annual / 100).toFixed(0)}/yr`
      : `$${(prices.monthly / 100).toFixed(0)}/mo`;
    console.log(pc.bold(`\nUpgrading to ${plan} plan (${price})...\n`));
  }

  // Resolve auth token
  let authToken: string;
  if (config.auth_mode === 'jwt' && config.member_api_key) {
    const cache = await getToken(config.supabase_url, config.member_api_key);
    authToken = cache?.jwt.token || config.supabase_service_role_key;
  } else {
    authToken = config.supabase_service_role_key;
  }

  try {
    const url = `${config.supabase_url}/functions/v1/create-checkout`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${authToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        org_id: config.org_id,
        plan,
        billing_cycle: billingCycle,
        success_url: 'https://dashboard.teamind.dev/billing/success',
        cancel_url: 'https://dashboard.teamind.dev/billing/cancel',
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      console.error(pc.red(`Error: Could not create checkout session (HTTP ${response.status}).`));
      if (body) {
        try {
          const parsed = JSON.parse(body);
          if (parsed.message) {
            console.error(pc.dim(parsed.message));
          }
        } catch {
          // Ignore parse error
        }
      }
      process.exit(1);
    }

    const data = await response.json();
    const checkoutUrl = data.checkout_url;

    if (!checkoutUrl) {
      console.error(pc.red('Error: No checkout URL returned.'));
      process.exit(1);
    }

    console.log(pc.green('Opening billing portal...'));
    console.log(pc.dim(checkoutUrl));

    await openInBrowser(checkoutUrl);
  } catch (err) {
    console.error(pc.red(`Error: ${(err as Error).message}`));
    process.exit(1);
  }
}
