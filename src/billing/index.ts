// Billing module — plan limits, usage checks, Stripe integration
// Phase 3: Search Intelligence, Data Quality & Growth
export { PLAN_LIMITS, PLAN_PRICES, OVERAGE_RATES, checkLimit } from './limits.js';
export {
  checkUsageOrProceed,
  checkUsageBeforeStore,
  checkUsageBeforeSearch,
} from './usage.js';
export type { UsageCheckResult } from './usage.js';
