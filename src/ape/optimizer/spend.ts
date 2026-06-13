/**
 * 285/T017: $40/run spend tracker + halt.
 *
 * Bounds optimizer cost (MUST NOT break — Cost invariant: `$40/run` default
 * hard cap, spend-logged, halts on exceed). `assertWithinCap()` throws a typed
 * `BudgetExceededError` once accumulated spend exceeds the cap.
 */

const DEFAULT_CAP_USD = 40;

/** Typed fail-loud error — thrown by `assertWithinCap` once spend exceeds the cap. */
export class BudgetExceededError extends Error {
  constructor(
    public readonly total: number,
    public readonly capUsd: number,
  ) {
    super(`spend $${total.toFixed(4)} exceeds cap $${capUsd.toFixed(2)}`);
    this.name = 'BudgetExceededError';
  }
}

export interface SpendTracker {
  add(usd: number): void;
  total(): number;
  remaining(): number;
  assertWithinCap(): void;
}

export function createSpendTracker(capUsd: number = DEFAULT_CAP_USD): SpendTracker {
  let spent = 0;
  return {
    add(usd: number): void {
      spent += usd;
    },
    total(): number {
      return spent;
    },
    remaining(): number {
      return capUsd - spent;
    },
    assertWithinCap(): void {
      if (spent > capUsd) {
        throw new BudgetExceededError(spent, capUsd);
      }
    },
  };
}
