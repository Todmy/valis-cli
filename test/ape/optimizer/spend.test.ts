import { describe, expect, it } from 'vitest';

import {
  BudgetExceededError,
  createBudget,
} from '../../../src/ape/optimizer/spend.js';

describe('createBudget', () => {
  it('counts calls', () => {
    const b = createBudget({ maxCalls: 10, maxTokensEst: 100_000 });
    expect(b.calls()).toBe(0);
    b.addCall(500);
    b.addCall(500);
    expect(b.calls()).toBe(2);
  });

  it('throws past maxCalls', () => {
    const b = createBudget({ maxCalls: 2, maxTokensEst: 100_000 });
    b.addCall(10);
    b.addCall(10);
    expect(() => b.assertWithin()).not.toThrow();
    b.addCall(10);
    expect(() => b.assertWithin()).toThrow(BudgetExceededError);
  });

  it('throws past maxTokensEst', () => {
    const b = createBudget({ maxCalls: 100, maxTokensEst: 1_000 });
    b.addCall(600);
    expect(() => b.assertWithin()).not.toThrow();
    b.addCall(600);
    expect(() => b.assertWithin()).toThrow(BudgetExceededError);
  });

  it('remaining tracks both caps', () => {
    const b = createBudget({ maxCalls: 5, maxTokensEst: 1_000 });
    b.addCall(200);
    expect(b.remaining()).toEqual({ calls: 4, tokensEst: 800 });
  });
});
