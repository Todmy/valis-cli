/**
 * `teamind upgrade` command — opens Stripe Checkout for plan upgrade.
 *
 * Creates a Stripe Checkout Session via the `create-checkout` Edge Function
 * and opens the resulting URL in the user's default browser.
 *
 * @module commands/upgrade
 */

import { loadConfig } from '../config/store.js';
import { getToken } from '../auth/jwt.js';
import { PLAN_LIMITS, PLAN_PRICES } from '../billing/limits.js';
import type { PlanTier } from '../types.js';
import { isHostedMode, resolveApiUrl, resolveApiPath } from '../cloud/api-url.js';

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
 * Falls back to printing the URL if `open` is unavailable.
 */
async function openUrl(url: string): Promise<void> {
  const { platform } = process;
  const { exec } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execAsync = promisify(exec);

  try {
    if (platform === 'darwin') {
      await execAsync(`open "${url}"`);
    } else if (platform === 'win32') {
      await execAsync(`start "" "${url}"`);
    } else {
      // Linux / other — try xdg-open
      await execAsync(`xdg-open "${url}"`);
    }
  } catch {
    // If browser open fails, the URL is already printed to console
  }
}

// ---------------------------------------------------------------------------
// Main command
// ---------------------------------------------------------------------------

export async function upgradeCommand(options: UpgradeOptions): Promise<void> {
  const config = await loadConfig();
  if (!config) {
    console.error('Not configured. Run `teamind init` first.');
    process.exit(1);
  }

  const targetPlan: 'team' | 'business' = options.plan ?? 'team';
  const billingCycle = options.annual ? 'annual' : 'monthly';

  // Validate plan choice
  if (targetPlan !== 'team' && targetPlan !== 'business') {
    console.error('Invalid plan. Choose "team" or "business".');
    process.exit(1);
  }

  // Show plan info
  const prices = PLAN_PRICES[targetPlan];
  const limits = PLAN_LIMITS[targetPlan];
  const priceDisplay = billingCycle === 'annual'
    ? `$${(prices.annual / 100).toFixed(0)}/yr`
    : `$${(prices.monthly / 100).toFixed(0)}/mo`;

  console.log(`Upgrading to ${targetPlan} plan (${priceDisplay})...`);
  console.log(`  Decisions: ${limits.decisions.toLocaleString()}`);
  console.log(`  Members:   ${limits.members}`);
  console.log(`  Searches:  ${limits.searches.toLocaleString()}/day`);
  console.log();

  // Get JWT for authenticated Edge Function call
  const apiKey = config.member_api_key ?? config.api_key;
  const tokenCache = await getToken(config.supabase_url, apiKey);
  const jwt = tokenCache?.jwt.token;

  if (!jwt) {
    console.error('Unable to authenticate. Try `teamind init` to re-authenticate.');
    process.exit(1);
  }

  try {
    const hosted = isHostedMode(config);
    const apiBase = resolveApiUrl(config.supabase_url, hosted);
    const url = resolveApiPath(apiBase, 'create-checkout');

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${jwt}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        org_id: config.org_id,
        plan: targetPlan,
        billing_cycle: billingCycle,
        success_url: 'https://dashboard.teamind.dev/billing/success',
        cancel_url: 'https://dashboard.teamind.dev/billing/cancel',
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      console.error(`Failed to create checkout session (HTTP ${response.status}): ${body}`);
      process.exit(1);
    }

    const data = await response.json() as { checkout_url: string };

    if (!data.checkout_url) {
      console.error('No checkout URL returned. Please try again.');
      process.exit(1);
    }

    console.log(`Opening billing portal: ${data.checkout_url}`);
    await openUrl(data.checkout_url);
  } catch (err) {
    console.error(
      `Upgrade failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  }
}
