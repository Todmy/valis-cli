import { describe, it, expect } from 'vitest';
import { handleTaxonomy } from '../../src/mcp/tools/taxonomy.js';

describe('handleTaxonomy', () => {
  it('returns the taxonomy spec with correct structure', async () => {
    const result = await handleTaxonomy({} as Record<string, never>);

    expect(result).toHaveProperty('types');
    expect(result).toHaveProperty('statuses');
    expect(result).toHaveProperty('areaConventions');
    expect(result).toHaveProperty('toolUsage');
    expect(result).toHaveProperty('version');
  });

  it('includes all four decision types', async () => {
    const result = await handleTaxonomy({} as Record<string, never>);

    expect(result.types).toContain('decision');
    expect(result.types).toContain('constraint');
    expect(result.types).toContain('pattern');
    expect(result.types).toContain('lesson');
    expect(result.types).toHaveLength(4);
  });

  it('includes all four statuses', async () => {
    const result = await handleTaxonomy({} as Record<string, never>);

    expect(result.statuses).toContain('active');
    expect(result.statuses).toContain('proposed');
    expect(result.statuses).toContain('deprecated');
    expect(result.statuses).toContain('superseded');
    expect(result.statuses).toHaveLength(4);
  });

  it('includes tool usage guidance for all tools', async () => {
    const result = await handleTaxonomy({} as Record<string, never>);

    expect(result.toolUsage).toHaveProperty('store');
    expect(result.toolUsage).toHaveProperty('search');
    expect(result.toolUsage).toHaveProperty('context');
    expect(result.toolUsage).toHaveProperty('lifecycle');
    expect(result.toolUsage).toHaveProperty('check_duplicate');
  });

  it('returns a valid semver version', async () => {
    const result = await handleTaxonomy({} as Record<string, never>);

    expect(result.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('returns the same result on repeated calls', async () => {
    const result1 = await handleTaxonomy({} as Record<string, never>);
    const result2 = await handleTaxonomy({} as Record<string, never>);

    expect(result1).toEqual(result2);
  });
});
