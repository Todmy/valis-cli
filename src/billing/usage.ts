/**
 * Usage check helper for CLI store/search operations.
 *
 * Calls the `check-usage` Edge Function before each operation.
 * Implements the fail-open guarantee (FR-018): if the check fails for
 * any reason (network error, timeout, Edge Function error), the operation
 * proceeds as if allowed.
 *
 * @module billing/usage
 */

import { getToken } from '../auth/jwt.js';
import {
  getSupabaseClient,
  getSupabaseJwtClient,
} from '../cloud/supabase.js';
import { HOSTED_SUPABASE_URL } from '../types.js';
import { resolveApiUrl, resolveApiPath } from '../cloud/api-url.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UsageCheckResult {
  /** Whether the operation is allowed. */
  allowed: boolean;
  /** Human-readable message when denied. */
  message?: string;
  /** Upgrade info when denied (free tier limit reached). */
  upgrade?: {
    message: string;
    checkout_url: string | null;
  };
  /** Current plan name. */
  plan?: string;
  /** Whether this operation incurs overage charges. */
  overage?: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Timeout for usage check requests (3 seconds). */
const USAGE_CHECK_TIMEOUT_MS = 3_000;

// ---------------------------------------------------------------------------
// Main function
// ---------------------------------------------------------------------------

/**
 * Check whether the current org can perform a store or search operation.
 *
 * **Fail-open guarantee**: On ANY error (network, timeout, HTTP error,
 * parse error, missing config), returns `{ allowed: true }`. Billing
 * failures must never block core operations.
 *
 * @param supabaseUrl - Supabase project URL
 * @param apiKey - API key (org-level or per-member) for JWT exchange
 * @param orgId - Organization ID
 * @param operation - 'store' or 'search'
 * @returns UsageCheckResult — check `allowed` to decide whether to proceed
 */
export async function checkUsageOrProceed(
  supabaseUrl: string,
  apiKey: string,
  orgId: string,
  operation: 'store' | 'search',
): Promise<UsageCheckResult> {
  try {
    // Get JWT token for authenticated Edge Function call
    const tokenCache = await getToken(supabaseUrl, apiKey);
    const jwt = tokenCache?.jwt.token;

    // No token available — fail-open (offline / auth issue)
    if (!jwt) {
      return { allowed: true };
    }

    const isHosted = supabaseUrl === HOSTED_SUPABASE_URL;
    const apiBase = resolveApiUrl(supabaseUrl, isHosted);
    const url = resolveApiPath(apiBase, 'check-usage');

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${jwt}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ org_id: orgId, operation }),
      signal: AbortSignal.timeout(USAGE_CHECK_TIMEOUT_MS),
    });

    // HTTP error from Edge Function — fail-open
    if (!response.ok) {
      return { allowed: true };
    }

    const data = await response.json() as {
      allowed: boolean;
      plan?: string;
      reason?: string;
      overage?: boolean;
      overage_rate?: string;
      upgrade?: { message: string; checkout_url: string | null };
    };

    if (data.allowed === false) {
      return {
        allowed: false,
        message: data.reason ?? 'Usage limit reached.',
        upgrade: data.upgrade,
        plan: data.plan,
      };
    }

    return {
      allowed: true,
      plan: data.plan,
      overage: data.overage ?? false,
    };
  } catch {
    // Network error, timeout, JSON parse error, etc.
    // NEVER block the operation — fail-open guarantee (FR-018)
    return { allowed: true };
  }
}

// ---------------------------------------------------------------------------
// Usage increment — upsert daily counters in rate_limits table
// ---------------------------------------------------------------------------

/**
 * Increment the daily usage counter for an organization after a successful
 * store or search operation.
 *
 * Uses an upsert into the `rate_limits` table:
 *   INSERT (org_id, day, decision_count, search_count_today)
 *   ON CONFLICT (org_id) DO UPDATE SET <counter> = <counter> + 1
 *
 * **Best-effort**: callers MUST wrap this in try/catch. A failure to
 * increment usage must never block the store/search operation.
 *
 * @param supabaseUrl - Supabase project URL
 * @param apiKeyOrServiceRole - API key (member or service_role) for Supabase client
 * @param orgId - Organization ID
 * @param operation - 'store' or 'search'
 * @param authMode - 'jwt' uses per-member JWT client, otherwise service_role client
 */
export async function incrementUsage(
  supabaseUrl: string,
  apiKeyOrServiceRole: string,
  orgId: string,
  operation: 'store' | 'search',
  authMode?: string,
): Promise<void> {
  const supabase = authMode === 'jwt'
    ? getSupabaseJwtClient(supabaseUrl, apiKeyOrServiceRole)
    : getSupabaseClient(supabaseUrl, apiKeyOrServiceRole);

  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

  if (operation === 'store') {
    // Upsert: insert new row or increment decision_count
    const { error } = await supabase
      .from('rate_limits')
      .upsert(
        {
          org_id: orgId,
          day: today,
          decision_count: 1,
          search_count_today: 0,
        },
        { onConflict: 'org_id' },
      );

    if (error) {
      // Fallback: try an RPC increment if the upsert fails (e.g. no upsert
      // permissions). This is still best-effort.
      await supabase.rpc('increment_rate_limit', {
        p_org_id: orgId,
        p_field: 'decision_count',
      });
    }
  } else {
    // Upsert: insert new row or increment search_count_today
    const { error } = await supabase
      .from('rate_limits')
      .upsert(
        {
          org_id: orgId,
          day: today,
          decision_count: 0,
          search_count_today: 1,
        },
        { onConflict: 'org_id' },
      );

    if (error) {
      await supabase.rpc('increment_rate_limit', {
        p_org_id: orgId,
        p_field: 'search_count_today',
      });
    }
  }
}
