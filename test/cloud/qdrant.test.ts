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
  it('includes all project ids plus legacy fallback', () => {
    const filter = buildAllProjectsFilter('org-1', ['proj-a', 'proj-b']);
    const must = filter.must as unknown[];
    const should = (must[1] as { should: unknown[] }).should;
    expect(should).toHaveLength(3); // 2 projects + is_null
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
