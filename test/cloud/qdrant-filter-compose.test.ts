/**
 * gh#325 — a structured filter must constrain the multi-project path exactly
 * as it constrains the single-project one. The merge is factored out so the
 * composition is testable without standing up an embedding round-trip.
 */

import { describe, it, expect } from 'vitest';
import {
  buildAllProjectsFilter,
  composePayloadFilter,
} from '../../src/cloud/qdrant/search.js';

describe('composePayloadFilter', () => {
  const base = buildAllProjectsFilter('org-1', ['p-1', 'p-2']);

  it('returns the base filter untouched when no payload filter is given', () => {
    expect(composePayloadFilter(base, undefined)).toEqual(base);
  });

  it('returns the base filter untouched when the payload filter is empty', () => {
    expect(composePayloadFilter(base, { must: [] })).toEqual(base);
  });

  it('appends the payload clauses to the base must array', () => {
    const clause = { key: 'status', match: { value: 'active' } };
    const merged = composePayloadFilter(base, { must: [clause] }) as { must: unknown[] };
    expect(merged.must).toContainEqual(clause);
  });

  it('keeps the multi-project match.any + is_null legacy clause intact', () => {
    const merged = composePayloadFilter(base, {
      must: [{ key: 'created_at', range: { gte: '2026-01-01T00:00:00Z' } }],
    }) as { must: unknown[] };
    expect(merged.must).toContainEqual({
      should: [
        { key: 'project_id', match: { any: ['p-1', 'p-2'] } },
        { is_null: { key: 'project_id' } },
      ],
    });
  });
});
