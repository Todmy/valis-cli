/**
 * 045/T007: knowledge-state fingerprint (R5).
 *
 * Asserts the hash's external properties: order-independence, sensitivity to
 * updated_at changes, active-only scoping, and the DecisionLite mapper shape.
 */
import { describe, it, expect } from 'vitest';
import {
  knowledgeStateHash,
  toDecisionLite,
  type DecisionRow,
} from '../../src/gaps/knowledge-state.js';
import type { DecisionLite } from '../../src/gaps/llm.js';

function lite(partial: Partial<DecisionLite> & { id: string }): DecisionLite {
  return {
    summary: 'summary',
    detail: 'detail',
    affects: [],
    status: 'active',
    updated_at: '2026-06-01T00:00:00.000Z',
    ...partial,
  };
}

describe('knowledgeStateHash', () => {
  it('is stable under reordering of the same decisions', () => {
    const a = lite({ id: 'a', updated_at: '2026-06-01T00:00:00.000Z' });
    const b = lite({ id: 'b', updated_at: '2026-06-02T00:00:00.000Z' });
    expect(knowledgeStateHash([a, b])).toBe(knowledgeStateHash([b, a]));
  });

  it('changes when a decision updated_at changes', () => {
    const before = [lite({ id: 'a', updated_at: '2026-06-01T00:00:00.000Z' })];
    const after = [lite({ id: 'a', updated_at: '2026-06-03T00:00:00.000Z' })];
    expect(knowledgeStateHash(before)).not.toBe(knowledgeStateHash(after));
  });

  it('ignores non-active decisions (only active contributes)', () => {
    const activeOnly = [lite({ id: 'a' })];
    const withProposed = [
      lite({ id: 'a' }),
      lite({ id: 'b', status: 'proposed', updated_at: '2026-06-09T00:00:00.000Z' }),
    ];
    expect(knowledgeStateHash(activeOnly)).toBe(knowledgeStateHash(withProposed));
  });

  it('changes when an active decision is added', () => {
    const one = [lite({ id: 'a' })];
    const two = [lite({ id: 'a' }), lite({ id: 'b', updated_at: '2026-06-05T00:00:00.000Z' })];
    expect(knowledgeStateHash(one)).not.toBe(knowledgeStateHash(two));
  });

  it('produces a 64-char hex SHA-256 digest', () => {
    expect(knowledgeStateHash([lite({ id: 'a' })])).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('toDecisionLite', () => {
  it('maps a decisions row and coalesces null affects to []', () => {
    const row: DecisionRow = {
      id: 'd1',
      summary: null,
      detail: 'we chose Stripe',
      affects: null,
      status: 'active',
      updated_at: '2026-06-01T00:00:00.000Z',
    };
    expect(toDecisionLite(row)).toEqual({
      id: 'd1',
      summary: null,
      detail: 'we chose Stripe',
      affects: [],
      status: 'active',
      updated_at: '2026-06-01T00:00:00.000Z',
    });
  });
});
