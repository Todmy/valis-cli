import { describe, it, expect } from 'vitest';
import { analyzeQuery } from '../../src/search/query-analyzer.js';

// ---------------------------------------------------------------------------
// Query type classification
// ---------------------------------------------------------------------------

describe('analyzeQuery — type classification', () => {
  it('classifies questions ending with "?" as factual', () => {
    const result = analyzeQuery('what database do we use?');
    expect(result.type).toBe('factual');
  });

  it('classifies queries starting with question words as factual', () => {
    expect(analyzeQuery('what database do we use').type).toBe('factual');
    expect(analyzeQuery('which auth method is preferred').type).toBe('factual');
    expect(analyzeQuery('how do we handle caching').type).toBe('factual');
    expect(analyzeQuery('where are configs stored').type).toBe('factual');
    expect(analyzeQuery('who manages deployments').type).toBe('factual');
    expect(analyzeQuery('when was the last migration').type).toBe('factual');
  });

  it('classifies "does/do/is/are" starters as factual', () => {
    expect(analyzeQuery('does the API support pagination').type).toBe('factual');
    expect(analyzeQuery('is Redis used for caching').type).toBe('factual');
    expect(analyzeQuery('are we using Kubernetes').type).toBe('factual');
  });

  it('classifies negation queries as negation type', () => {
    expect(analyzeQuery('what NOT to do for caching').type).toBe('negation');
    expect(analyzeQuery("don't use Redis").type).toBe('negation');
    expect(analyzeQuery('avoid using MySQL').type).toBe('negation');
    expect(analyzeQuery('instead of MongoDB').type).toBe('negation');
  });

  it('classifies general phrases as exploratory', () => {
    expect(analyzeQuery('decisions about auth').type).toBe('exploratory');
    expect(analyzeQuery('caching strategy').type).toBe('exploratory');
    expect(analyzeQuery('API design patterns').type).toBe('exploratory');
    expect(analyzeQuery('deployment infrastructure').type).toBe('exploratory');
  });

  it('negation takes priority over factual', () => {
    const result = analyzeQuery('what NOT to do for caching');
    expect(result.type).toBe('negation');
  });
});

// ---------------------------------------------------------------------------
// Entity extraction
// ---------------------------------------------------------------------------

describe('analyzeQuery — entity extraction', () => {
  it('extracts key entities from a factual query', () => {
    const result = analyzeQuery('what database do we use?');
    expect(result.entities).toContain('database');
    expect(result.entities).toContain('use');
  });

  it('extracts entities from exploratory query', () => {
    const result = analyzeQuery('caching strategy');
    expect(result.entities).toContain('caching');
    expect(result.entities).toContain('strategy');
  });

  it('removes stopwords', () => {
    const result = analyzeQuery('what is the best approach for API design');
    expect(result.entities).not.toContain('what');
    expect(result.entities).not.toContain('is');
    expect(result.entities).not.toContain('the');
    expect(result.entities).not.toContain('for');
    expect(result.entities).toContain('best');
    expect(result.entities).toContain('approach');
    expect(result.entities).toContain('api');
    expect(result.entities).toContain('design');
  });

  it('deduplicates entities', () => {
    const result = analyzeQuery('auth auth authentication');
    expect(result.entities.filter((e) => e === 'auth')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Negation detection
// ---------------------------------------------------------------------------

describe('analyzeQuery — negation detection', () => {
  it('detects "NOT" keyword', () => {
    expect(analyzeQuery('NOT using Redis').hasNegation).toBe(true);
  });

  it("detects \"don't\"", () => {
    expect(analyzeQuery("don't use MySQL").hasNegation).toBe(true);
  });

  it('detects "avoid"', () => {
    expect(analyzeQuery('avoid monoliths').hasNegation).toBe(true);
  });

  it('detects "instead of"', () => {
    expect(analyzeQuery('instead of MongoDB use Postgres').hasNegation).toBe(true);
  });

  it('detects "never"', () => {
    expect(analyzeQuery('never deploy on Fridays').hasNegation).toBe(true);
  });

  it('does not detect negation in normal queries', () => {
    expect(analyzeQuery('database migration strategy').hasNegation).toBe(false);
    expect(analyzeQuery('authentication patterns').hasNegation).toBe(false);
  });

  it('does not false-positive on partial word matches', () => {
    // "notation" contains "not" but shouldn't trigger negation
    expect(analyzeQuery('notation system').hasNegation).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('analyzeQuery — edge cases', () => {
  it('handles empty query', () => {
    const result = analyzeQuery('');
    expect(result.type).toBe('exploratory');
    expect(result.entities).toEqual([]);
    expect(result.hasNegation).toBe(false);
  });

  it('handles single-word query', () => {
    const result = analyzeQuery('caching');
    expect(result.type).toBe('exploratory');
    expect(result.entities).toContain('caching');
  });

  it('preserves the original query string', () => {
    const result = analyzeQuery('What Database do we USE?');
    expect(result.originalQuery).toBe('What Database do we USE?');
  });
});
