import type { PlanLimits, PlanTier } from '../types.js';

// ---------------------------------------------------------------------------
// Plan limit constants (Phase 3)
// ---------------------------------------------------------------------------

/**
 * Hard limits per plan tier. Enterprise has no limits.
 * These are enforced at the application level (check-usage Edge Function).
 */
export const PLAN_LIMITS: Readonly<Record<PlanTier, PlanLimits>> = {
  free:       { decisions: 100,      members: 2,        searches: 100,      overage: false },
  team:       { decisions: 5_000,    members: 25,       searches: 1_000,    overage: true  },
  business:   { decisions: 25_000,   members: 50,       searches: 5_000,    overage: true  },
  enterprise: { decisions: Infinity, members: Infinity,  searches: Infinity, overage: false },
} as const;

/**
 * Monthly prices in USD cents per plan tier (per billing cycle).
 */
export const PLAN_PRICES: Readonly<Record<Exclude<PlanTier, 'free'>, { monthly: number; annual: number }>> = {
  team:       { monthly: 2_900,   annual: 29_000  },   // $29/mo or $290/yr
  business:   { monthly: 9_900,   annual: 99_000  },   // $99/mo or $990/yr
  enterprise: { monthly: 0,       annual: 0       },    // Custom pricing
} as const;

/**
 * Overage rates for paid plans that exceed their limits.
 * Applied per-unit above the plan ceiling.
 */
export const OVERAGE_RATES = {
  /** $0.005 per decision over limit (0.5 cents). */
  decision_cents: 0.5,
  /** $0.002 per search over limit (0.2 cents). */
  search_cents: 0.2,
} as const;

// ---------------------------------------------------------------------------
// Pure check functions
// ---------------------------------------------------------------------------

/** Operation types that can be checked against plan limits. */
export type CheckableOperation = 'decisions' | 'members' | 'searches';

/** Result of a plan limit check. */
export interface LimitCheckResult {
  /** Whether the operation is allowed. */
  allowed: boolean;
  /** Current usage count. */
  current: number;
  /** Maximum allowed for this plan. */
  limit: number;
  /** Whether overage billing applies (paid plans only). */
  overage: boolean;
  /** Plan tier that was checked. */
  plan: PlanTier;
}

/**
 * Check whether an operation is within plan limits.
 *
 * Pure function — no side effects, no network calls.
 * Returns whether the operation is allowed and overage status.
 *
 * @param plan - The organization's plan tier
 * @param operation - The type of operation to check
 * @param currentUsage - Current usage count for this operation
 * @returns LimitCheckResult with allowed/denied status and details
 */
export function checkLimit(
  plan: PlanTier,
  operation: CheckableOperation,
  currentUsage: number,
): LimitCheckResult {
  const limits = PLAN_LIMITS[plan];
  const limit = limits[operation];

  // Enterprise has unlimited everything
  if (limit === Infinity) {
    return { allowed: true, current: currentUsage, limit, overage: false, plan };
  }

  const withinLimit = currentUsage < limit;

  // Free tier: hard block, no overage
  if (!limits.overage) {
    return { allowed: withinLimit, current: currentUsage, limit, overage: false, plan };
  }

  // Paid plans: always allowed (overage billing kicks in above limit)
  return {
    allowed: true,
    current: currentUsage,
    limit,
    overage: !withinLimit,
    plan,
  };
}
