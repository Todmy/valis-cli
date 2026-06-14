/**
 * 285/RT8: call/token budget tracker + halt.
 *
 * Re-plan v2 trial-execution model = in-session subagents — no AI Gateway, no
 * external key, no USD. The optimizer cost is now bounded by two non-monetary
 * caps: number of subagent calls and an estimated-token ceiling. `assertWithin()`
 * throws a typed `BudgetExceededError` once EITHER cap is exceeded (fail-loud).
 * Replaces the USD `createSpendTracker` / `assertWithinCap` path.
 *
 * NOTE: `BudgetCaps` / `Budget` are the canonical types in `ape/types.ts`
 * (promoted by RT9); re-exported here so `optimizer/spend.js` consumers keep one
 * source of truth.
 */

import type { BudgetCaps, Budget } from '../types.js';

export type { BudgetCaps, Budget } from '../types.js';

/** Typed fail-loud error — thrown by `assertWithin` once either cap is exceeded. */
export class BudgetExceededError extends Error {
  constructor(
    public readonly calls: number,
    public readonly tokensEst: number,
    public readonly maxCalls: number,
    public readonly maxTokensEst: number,
  ) {
    super(
      `budget exceeded: ${calls}/${maxCalls} calls, ${tokensEst}/${maxTokensEst} est. tokens`,
    );
    this.name = 'BudgetExceededError';
  }
}

export function createBudget({ maxCalls, maxTokensEst }: BudgetCaps): Budget {
  let calls = 0;
  let tokensEst = 0;
  return {
    addCall(t: number): void {
      calls += 1;
      tokensEst += t;
    },
    calls(): number {
      return calls;
    },
    remaining(): { calls: number; tokensEst: number } {
      return { calls: maxCalls - calls, tokensEst: maxTokensEst - tokensEst };
    },
    assertWithin(): void {
      if (calls > maxCalls || tokensEst > maxTokensEst) {
        throw new BudgetExceededError(calls, tokensEst, maxCalls, maxTokensEst);
      }
    },
  };
}
