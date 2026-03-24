/**
 * Usage check helper for billing integration.
 *
 * Key invariant: Billing NEVER blocks operations (Constitution III).
 * All errors — network, timeout, Edge Function failure — result in
 * a fail-open response that allows the operation to proceed.
 */

import { loadConfig } from '../config/store.js';
import { getToken } from '../auth/jwt.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UsageCheckResult {
  /** Whether the operation is allowed. */
  allowed: boolean;
  /** Human-readable message when denied. */
  message?: string;
  /** Upgrade info when denied (free tier). */
  upgrade?: {
    message: string;
    checkout_url: string | null;
  };
}

// ---------------------------------------------------------------------------
// Fail-open constant
// ---------------------------------------------------------------------------

const FAIL_OPEN: UsageCheckResult = { allowed: true };

/** Timeout for usage check requests (3 seconds). */
const USAGE_CHECK_TIMEOUT_MS = 3_000;

// ---------------------------------------------------------------------------
// Main helper
// ---------------------------------------------------------------------------

/**
 * Check whether the current org has capacity for the given operation.
 *
 * Fail-open guarantee: returns `{ allowed: true }` on ANY error —
 * network failure, timeout, Edge Function error, missing config, etc.
 *
 * @param orgId - The organization ID to check
 * @param operation - 'store' or 'search'
 * @returns UsageCheckResult with allowed/denied status
 */
export async function checkUsageOrProceed(
  orgId: string,
  operation: 'store' | 'search',
): Promise<UsageCheckResult> {
  try {
    const config = await loadConfig();
    if (!config) {
      return FAIL_OPEN; // No config -> fail open
    }

    // Resolve JWT for auth header
    let jwt: string | undefined;
    if (config.auth_mode === 'jwt' && config.member_api_key) {
      const cache = await getToken(config.supabase_url, config.member_api_key);
      jwt = cache?.jwt.token;
    }

    // Fall back to service role key if no JWT available
    const authToken = jwt || config.supabase_service_role_key;
    if (!authToken) {
      return FAIL_OPEN;
    }

    const url = `${config.supabase_url}/functions/v1/check-usage`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${authToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ org_id: orgId, operation }),
      signal: AbortSignal.timeout(USAGE_CHECK_TIMEOUT_MS),
    });

    // Non-OK response -> fail open
    if (!response.ok) {
      return FAIL_OPEN;
    }

    const data = await response.json();

    if (data.allowed === false) {
      return {
        allowed: false,
        message: data.reason || 'Usage limit reached.',
        upgrade: data.upgrade,
      };
    }

    // Allowed (possibly with overage info — still allowed)
    return FAIL_OPEN;
  } catch {
    // Network error, timeout, JSON parse error, etc. — never block
    return FAIL_OPEN;
  }
}

// ---------------------------------------------------------------------------
// Convenience wrappers
// ---------------------------------------------------------------------------

/**
 * Check usage before a store operation. Returns a UsageCheckResult.
 * If `allowed` is false, the caller should return an error with upgrade info
 * instead of proceeding with the store.
 */
export async function checkUsageBeforeStore(
  orgId: string,
): Promise<UsageCheckResult> {
  return checkUsageOrProceed(orgId, 'store');
}

/**
 * Check usage before a search operation. Returns a UsageCheckResult.
 * If `allowed` is false, the caller should return empty results with the
 * upgrade message instead of proceeding with the search.
 */
export async function checkUsageBeforeSearch(
  orgId: string,
): Promise<UsageCheckResult> {
  return checkUsageOrProceed(orgId, 'search');
}
