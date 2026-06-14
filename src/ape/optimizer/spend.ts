/**
 * 285/RT8: call/token budget tracker + halt.
 *
 * Re-plan v2 trial-execution model = in-session subagents — no AI Gateway, no
 * external key, no USD. The optimizer cost is now bounded by two non-monetary
 * caps: number of subagent calls and an estimated-token ceiling. `assertWithin()`
 * throws a typed `BudgetExceededError` once EITHER cap is exceeded (fail-loud).
 * Replaces the USD `createSpendTracker` / `assertWithinCap` path.
 */

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

export interface BudgetCaps {
  maxCalls: number;
  maxTokensEst: number;
}

export interface Budget {
  addCall(tokensEst: number): void;
  calls(): number;
  remaining(): { calls: number; tokensEst: number };
  assertWithin(): void;
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
