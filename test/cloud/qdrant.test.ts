import { describe, it, expect } from 'vitest';
import {
  getQdrantClient,
  resetClient,
  healthCheck,
  buildProjectFilter,
  buildAllProjectsFilter,
  isLegacyPoint,
} from '../../src/cloud/qdrant.js';

describe('Qdrant Client', () => {
  it('creates a client instance', () => {
    resetClient();
    const client = getQdrantClient('https://test.qdrant.io', 'test-key');
    expect(client).toBeDefined();
  });

  it('returns same instance on subsequent calls', () => {
    const client1 = getQdrantClient('https://test.qdrant.io', 'test-key');
    const client2 = getQdrantClient('https://test.qdrant.io', 'test-key');
    expect(client1).toBe(client2);
  });

  it('healthCheck returns false for invalid URL', async () => {
    resetClient();
    const client = getQdrantClient('https://invalid.qdrant.io:6333', 'bad-key');
    const result = await healthCheck(client);
    expect(result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// T037/T039: Project filter backward compatibility
// ---------------------------------------------------------------------------

describe('buildProjectFilter — project_id backward compat', () => {
  it('defaults to org-only filter when no project specified', () => {
    const filter = buildProjectFilter('org-1');
    expect(filter).toEqual({
      must: [{ key: 'org_id', match: { value: 'org-1' } }],
    });
  });

  it('includes legacy fallback by default for project-scoped filter', () => {
    const filter = buildProjectFilter('org-1', 'proj-1');
    const must = filter.must as unknown[];
    expect(must).toHaveLength(2);
    const should = (must[1] as { should: unknown[] }).should;
    expect(should).toHaveLength(2);
    // First: exact match
    expect(should[0]).toEqual({ key: 'project_id', match: { value: 'proj-1' } });
    // Second: is_null fallback for legacy
    expect(should[1]).toEqual({ is_null: { key: 'project_id' } });
  });

  it('strict mode excludes legacy fallback', () => {
    const filter = buildProjectFilter('org-1', 'proj-1', { legacyFallback: false });
    const must = filter.must as unknown[];
    expect(must[1]).toEqual({ key: 'project_id', match: { value: 'proj-1' } });
  });
});

describe('buildAllProjectsFilter', () => {
  it('uses match.any for project ids plus legacy is_null fallback', () => {
    // Shape changed in commit f3184bf3 (2026-04-14): Qdrant Cloud rejects
    // N individual `match.value` clauses inside a nested `should` with 400
    // Bad Request on cross-project search. Replaced with `match.any`.
    // Legacy `is_null` fallback remains.
    const filter = buildAllProjectsFilter('org-1', ['proj-a', 'proj-b']);
    const must = filter.must as unknown[];
    const should = (must[1] as { should: unknown[] }).should;
    expect(should).toHaveLength(2); // match.any (covers all projects) + is_null
    expect(should[0]).toEqual({ key: 'project_id', match: { any: ['proj-a', 'proj-b'] } });
    expect(should[1]).toEqual({ is_null: { key: 'project_id' } });
  });
});

describe('isLegacyPoint', () => {
  it('returns true for missing project_id', () => {
    expect(isLegacyPoint({ org_id: 'org-1' })).toBe(true);
  });

  it('returns false for present project_id', () => {
    expect(isLegacyPoint({ org_id: 'org-1', project_id: 'proj-1' })).toBe(false);
  });
});
