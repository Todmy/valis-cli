/**
 * Tests for `SearchFilterBuilder` (032/Track 6).
 *
 * Tabular unit tests over the pure `buildSearchFilter` function — no Qdrant,
 * no I/O. Coverage targets the spec's quality bar (SC-005: ≥12 tests):
 *   - Each filter field translated correctly
 *   - Range bounds (confidence + created_at) with clamping + inversion
 *   - match.any for array fields with empty-array exception
 *   - Closed-world enum drops
 *   - usedFilterDimensions telemetry helper
 */

import { describe, it, expect } from 'vitest';
import {
  buildSearchFilter,
  usedFilterDimensions,
  STRUCTURED_FILTER_FIELDS,
} from '../../src/search/filter-builder.js';

describe('buildSearchFilter — empty / pass-through', () => {
  it('produces an empty must[] when no filters are supplied', () => {
    const { filter, dropped_args, clamped_args } = buildSearchFilter({});
    expect(filter.must).toEqual([]);
    expect(dropped_args).toEqual([]);
    expect(clamped_args).toEqual([]);
  });
});

describe('buildSearchFilter — single-dimension translations', () => {
  it('translates type into a keyword match', () => {
    const r = buildSearchFilter({ type: 'lesson' });
    expect(r.filter.must).toEqual([{ key: 'type', match: { value: 'lesson' } }]);
  });

  it('translates status into a keyword match', () => {
    const r = buildSearchFilter({ status: 'proposed' });
    expect(r.filter.must).toEqual([{ key: 'status', match: { value: 'proposed' } }]);
  });

  it('translates author into a keyword match', () => {
    const r = buildSearchFilter({ author: 'alice' });
    expect(r.filter.must).toEqual([{ key: 'author', match: { value: 'alice' } }]);
  });

  it('translates pinned bool into a bool match', () => {
    const r = buildSearchFilter({ pinned: true });
    expect(r.filter.must).toEqual([{ key: 'pinned', match: { value: true } }]);
  });

  it('translates source into a keyword match', () => {
    const r = buildSearchFilter({ source: 'seed' });
    expect(r.filter.must).toEqual([{ key: 'source', match: { value: 'seed' } }]);
  });

  it('translates outcome into a keyword match', () => {
    const r = buildSearchFilter({ outcome: 'failed' });
    expect(r.filter.must).toEqual([{ key: 'outcome', match: { value: 'failed' } }]);
  });
});

describe('buildSearchFilter — affects (match.any with empty-array exception)', () => {
  it('translates affects into a match.any predicate', () => {
    const r = buildSearchFilter({ affects: ['postgres', 'supabase'] });
    expect(r.filter.must).toEqual([
      { key: 'affects', match: { any: ['postgres', 'supabase'] } },
    ]);
  });

  it('treats affects=[] as no constraint (Qdrant match.any-with-zero-terms degenerate)', () => {
    const r = buildSearchFilter({ affects: [] });
    expect(r.filter.must).toEqual([]);
    expect(r.dropped_args).toEqual([]);
  });

  it('filters out empty-string entries in affects array', () => {
    const r = buildSearchFilter({ affects: ['postgres', '   ', '', 'supabase'] });
    expect(r.filter.must).toEqual([
      { key: 'affects', match: { any: ['postgres', 'supabase'] } },
    ]);
  });

  it('drops affects when the value is not an array', () => {
    const r = buildSearchFilter({ affects: 'postgres' as unknown as string[] });
    expect(r.filter.must).toEqual([]);
    expect(r.dropped_args).toEqual([{ field: 'affects', reason: 'not_an_array' }]);
  });
});

describe('buildSearchFilter — confidence range', () => {
  it('emits a range predicate with both bounds', () => {
    const r = buildSearchFilter({ min_confidence: 0.5, max_confidence: 0.9 });
    expect(r.filter.must).toEqual([
      { key: 'confidence', range: { gte: 0.5, lte: 0.9 } },
    ]);
    expect(r.clamped_args).toEqual([]);
  });

  it('emits a one-sided range when only min is supplied', () => {
    const r = buildSearchFilter({ min_confidence: 0.7 });
    expect(r.filter.must).toEqual([
      { key: 'confidence', range: { gte: 0.7 } },
    ]);
  });

  it('clamps min_confidence below 0 up to 0 and records the clamp', () => {
    const r = buildSearchFilter({ min_confidence: -0.5 });
    expect(r.filter.must).toEqual([
      { key: 'confidence', range: { gte: 0 } },
    ]);
    expect(r.clamped_args).toEqual([
      { field: 'min_confidence', original: -0.5, clamped: 0 },
    ]);
  });

  it('clamps max_confidence above 1 down to 1 and records the clamp', () => {
    const r = buildSearchFilter({ max_confidence: 1.5 });
    expect(r.filter.must).toEqual([
      { key: 'confidence', range: { lte: 1 } },
    ]);
    expect(r.clamped_args).toEqual([
      { field: 'max_confidence', original: 1.5, clamped: 1 },
    ]);
  });

  it('drops the inverted bound when min_confidence > max_confidence', () => {
    const r = buildSearchFilter({ min_confidence: 0.9, max_confidence: 0.5 });
    // min survives → range has gte=0.9 only
    expect(r.filter.must).toEqual([
      { key: 'confidence', range: { gte: 0.9 } },
    ]);
    expect(r.dropped_args).toEqual([
      { field: 'max_confidence', reason: 'inverted_range' },
    ]);
  });

  it('drops a non-numeric confidence value', () => {
    const r = buildSearchFilter({
      min_confidence: Number.NaN as unknown as number,
    });
    expect(r.filter.must).toEqual([]);
    expect(r.dropped_args).toEqual([
      { field: 'min_confidence', reason: 'not_a_number' },
    ]);
  });
});

describe('buildSearchFilter — created_at range', () => {
  it('parses ISO-8601 dates into a numeric range on created_at', () => {
    const r = buildSearchFilter({
      created_after: '2026-05-01',
      created_before: '2026-05-31T23:59:59Z',
    });
    const cond = r.filter.must[0];
    expect(cond.key).toBe('created_at');
    expect((cond as { range: { gte: number; lte: number } }).range.gte).toBe(
      Date.parse('2026-05-01'),
    );
    expect((cond as { range: { gte: number; lte: number } }).range.lte).toBe(
      Date.parse('2026-05-31T23:59:59Z'),
    );
  });

  it('drops an unparseable date string with reason invalid_date_format', () => {
    const r = buildSearchFilter({ created_after: 'yesterday' });
    expect(r.filter.must).toEqual([]);
    expect(r.dropped_args).toEqual([
      { field: 'created_after', reason: 'invalid_date_format' },
    ]);
  });

  it('drops created_before when it precedes created_after', () => {
    const r = buildSearchFilter({
      created_after: '2026-05-15',
      created_before: '2026-05-01',
    });
    // created_after survives, created_before dropped as inverted
    const cond = r.filter.must[0];
    expect(cond.key).toBe('created_at');
    expect((cond as { range: { gte: number; lte?: number } }).range.lte).toBeUndefined();
    expect(r.dropped_args).toEqual([
      { field: 'created_before', reason: 'inverted_range' },
    ]);
  });
});

describe('buildSearchFilter — unknown enums dropped', () => {
  const dropCases: Array<[keyof Parameters<typeof buildSearchFilter>[0], string]> = [
    ['type', 'bogus_type'],
    ['status', 'fakestate'],
    ['source', 'cosmic_ray'],
    ['outcome', 'meh'],
  ];

  for (const [field, bad] of dropCases) {
    it(`drops unknown enum value on ${field}`, () => {
      const args = { [field]: bad } as unknown as Parameters<
        typeof buildSearchFilter
      >[0];
      const r = buildSearchFilter(args);
      expect(r.filter.must).toEqual([]);
      expect(r.dropped_args).toEqual([
        { field: String(field), reason: 'unknown_enum_value' },
      ]);
    });
  }
});

describe('buildSearchFilter — combined filters', () => {
  it('composes 5 dimensions into a single must[] (US1 killer use case)', () => {
    const r = buildSearchFilter({
      type: 'lesson',
      status: 'active',
      min_confidence: 0.8,
      created_after: '2026-05-01',
      affects: ['postgres'],
    });
    // Order is stable: type, status, confidence, created_at, affects.
    expect(r.filter.must.map((c) => c.key)).toEqual([
      'type',
      'status',
      'confidence',
      'created_at',
      'affects',
    ]);
    expect(r.dropped_args).toEqual([]);
    expect(r.clamped_args).toEqual([]);
  });

  it('accumulates multiple diagnostic entries when several args are invalid', () => {
    const r = buildSearchFilter({
      type: 'bogus' as unknown as 'lesson',
      min_confidence: -1,
      created_after: 'yesterday',
    });
    expect(r.dropped_args.map((d) => d.field)).toEqual([
      'type',
      'created_after',
    ]);
    expect(r.clamped_args.map((c) => c.field)).toEqual(['min_confidence']);
  });
});

describe('usedFilterDimensions', () => {
  it('returns the subset of structured fields present in the args', () => {
    const dims = usedFilterDimensions({
      type: 'lesson',
      status: 'active',
      min_confidence: 0.8,
    });
    expect(dims).toEqual(['type', 'status', 'min_confidence']);
  });

  it('returns an empty array when no structured filters are set', () => {
    expect(usedFilterDimensions({})).toEqual([]);
  });

  it('exposes the canonical field list', () => {
    // FR-014: 11 fields including `type` (carried in for telemetry uniformity)
    expect(STRUCTURED_FILTER_FIELDS).toHaveLength(11);
  });
});
