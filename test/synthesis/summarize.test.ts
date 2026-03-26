/**
 * Tests for template-based group summary generation.
 */

import { describe, it, expect } from 'vitest';
import { generateGroupSummary } from '../../src/synthesis/summarize.js';
import type { Decision } from '../../src/types.js';

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

function makeDecision(overrides: Partial<Decision> & { id: string }): Decision {
  return {
    org_id: 'org-1',
    type: 'decision',
    summary: null,
    detail: `Detail text for decision ${overrides.id}`,
    status: 'active',
    author: 'alice',
    source: 'mcp_store',
    project_id: 'proj-1',
    session_id: null,
    content_hash: `hash-${overrides.id}`,
    confidence: 0.5,
    affects: [],
    created_at: '2026-03-20T00:00:00Z',
    updated_at: '2026-03-20T00:00:00Z',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('generateGroupSummary', () => {
  it('returns empty string for empty input', () => {
    expect(generateGroupSummary([])).toBe('');
  });

  it('returns single decision summary for one decision', () => {
    const d = makeDecision({
      id: 'a',
      summary: 'Use JWT for auth',
    });

    const result = generateGroupSummary([d]);
    expect(result).toBe('Use JWT for auth');
  });

  it('falls back to detail when no summary', () => {
    const d = makeDecision({
      id: 'a',
      summary: null,
      detail: 'We should use JWT tokens for authentication',
    });

    const result = generateGroupSummary([d]);
    expect(result).toBe('We should use JWT tokens for authentication');
  });

  it('groups decisions by affects area', () => {
    const decisions = [
      makeDecision({
        id: 'a',
        summary: 'Use bcrypt for passwords',
        affects: ['auth'],
        created_at: '2026-03-22T00:00:00Z',
      }),
      makeDecision({
        id: 'b',
        summary: 'Use JWT for sessions',
        affects: ['auth'],
        created_at: '2026-03-21T00:00:00Z',
      }),
    ];

    const result = generateGroupSummary(decisions);
    expect(result).toContain('## auth');
    expect(result).toContain('2 related decision(s)');
    expect(result).toContain('Use bcrypt for passwords');
    expect(result).toContain('Use JWT for sessions');
  });

  it('includes Consolidated section with newest decision as base', () => {
    const decisions = [
      makeDecision({
        id: 'a',
        summary: 'Use bcrypt for password hashing in the auth module.',
        affects: ['auth'],
        created_at: '2026-03-22T00:00:00Z',
      }),
      makeDecision({
        id: 'b',
        summary: 'Also enable rate limiting on login endpoint.',
        affects: ['auth'],
        created_at: '2026-03-21T00:00:00Z',
      }),
    ];

    const result = generateGroupSummary(decisions);
    expect(result).toContain('Consolidated:');
    // Newest decision text should be the base
    expect(result).toContain('Use bcrypt for password hashing');
  });

  it('appends unique info from older decisions', () => {
    const decisions = [
      makeDecision({
        id: 'a',
        summary: 'Use bcrypt for password hashing.',
        affects: ['auth'],
        created_at: '2026-03-22T00:00:00Z',
      }),
      makeDecision({
        id: 'b',
        summary: 'Enable rate limiting on the login endpoint to prevent brute force.',
        affects: ['auth'],
        created_at: '2026-03-21T00:00:00Z',
      }),
    ];

    const result = generateGroupSummary(decisions);
    // The unique sentence from decision b should appear
    expect(result).toContain('Additionally:');
  });

  it('handles decisions with multiple affects areas', () => {
    const decisions = [
      makeDecision({
        id: 'a',
        summary: 'Decision about auth and API.',
        affects: ['auth', 'api'],
        created_at: '2026-03-22T00:00:00Z',
      }),
      makeDecision({
        id: 'b',
        summary: 'Another decision about database.',
        affects: ['database'],
        created_at: '2026-03-21T00:00:00Z',
      }),
    ];

    const result = generateGroupSummary(decisions);
    // Should have sections for the areas
    expect(result).toContain('##');
  });

  it('uses "general" when affects is empty', () => {
    const decisions = [
      makeDecision({
        id: 'a',
        summary: 'First general decision.',
        affects: [],
        created_at: '2026-03-22T00:00:00Z',
      }),
      makeDecision({
        id: 'b',
        summary: 'Second general decision.',
        affects: [],
        created_at: '2026-03-21T00:00:00Z',
      }),
    ];

    const result = generateGroupSummary(decisions);
    expect(result).toContain('## general');
  });

  it('deduplicates decisions across multiple area headings', () => {
    const decisions = [
      makeDecision({
        id: 'a',
        summary: 'Shared auth and api decision.',
        affects: ['auth', 'api'],
        created_at: '2026-03-22T00:00:00Z',
      }),
      makeDecision({
        id: 'b',
        summary: 'Another auth decision.',
        affects: ['auth'],
        created_at: '2026-03-21T00:00:00Z',
      }),
    ];

    const result = generateGroupSummary(decisions);
    // Decision 'a' should not appear under a separate 'api' heading since
    // it was already covered under 'auth'. There should be only one section header.
    const sectionCount = (result.match(/^## /gm) ?? []).length;
    expect(sectionCount).toBe(1);
    expect(result).toContain('## auth');
    // 'api' section should not exist because 'a' was already covered under 'auth'
    expect(result).not.toContain('## api');
  });
});
