import { describe, expect, it } from 'vitest';

import {
  BudgetExceededError,
  createSpendTracker,
} from '../../../src/ape/optimizer/spend.js';

describe('createSpendTracker', () => {
  it('accumulates', () => {
    const t = createSpendTracker(40);
    t.add(1.5);
    t.add(2.5);
    expect(t.total()).toBe(4);
  });

  it('remaining decreases', () => {
    const t = createSpendTracker(40);
    expect(t.remaining()).toBe(40);
    t.add(10);
    expect(t.remaining()).toBe(30);
    t.add(5);
    expect(t.remaining()).toBe(25);
  });

  it('throws when over cap', () => {
    const t = createSpendTracker(40);
    t.add(41);
    expect(() => t.assertWithinCap()).toThrow(BudgetExceededError);
  });

  it('default cap is 40', () => {
    const t = createSpendTracker();
    expect(t.remaining()).toBe(40);
    t.add(40);
    expect(() => t.assertWithinCap()).not.toThrow();
    t.add(0.01);
    expect(() => t.assertWithinCap()).toThrow(BudgetExceededError);
  });
});
