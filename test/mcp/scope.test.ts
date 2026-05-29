import { describe, it, expect } from 'vitest';
import {
  buildScopeEnvelope,
  buildScopeHint,
} from '../../src/mcp/tools/scope.js';

describe('buildScopeEnvelope', () => {
  const accessible = [
    { id: 'A', name: 'Alpha' },
    { id: 'B', name: 'Beta' },
    { id: 'C', name: 'Gamma' },
  ];

  it('resolves active_project.name from the matching accessible entry', () => {
    const env = buildScopeEnvelope({
      activeProjectId: 'B',
      accessibleProjects: accessible,
      queriedAllProjects: false,
    });
    expect(env.active_project).toEqual({ id: 'B', name: 'Beta' });
    expect(env.accessible_projects).toHaveLength(3);
    expect(env.queried_all_projects).toBe(false);
  });

  it('emits name: null when the active id is absent from accessible projects', () => {
    const env = buildScopeEnvelope({
      activeProjectId: 'Z',
      accessibleProjects: accessible,
      queriedAllProjects: false,
    });
    expect(env.active_project).toEqual({ id: 'Z', name: null });
  });

  it('emits name: null when the matching entry has an empty name (degraded lookup)', () => {
    const env = buildScopeEnvelope({
      activeProjectId: 'A',
      accessibleProjects: [{ id: 'A', name: '' }],
      queriedAllProjects: false,
    });
    expect(env.active_project).toEqual({ id: 'A', name: null });
    expect(env.accessible_projects).toEqual([{ id: 'A', name: '' }]);
  });

  it('passes queried_all_projects through verbatim', () => {
    const env = buildScopeEnvelope({
      activeProjectId: 'A',
      accessibleProjects: accessible,
      queriedAllProjects: true,
    });
    expect(env.queried_all_projects).toBe(true);
  });
});

describe('buildScopeHint', () => {
  it('emits a hint mentioning all_projects on empty results with >1 accessible project', () => {
    const hint = buildScopeHint(0, 3, false);
    expect(hint).toBeDefined();
    expect(hint).toContain('all_projects');
  });

  it('suppresses the hint when results are non-empty', () => {
    expect(buildScopeHint(5, 3, false)).toBeUndefined();
  });

  it('suppresses the hint for a single-project member', () => {
    expect(buildScopeHint(0, 1, false)).toBeUndefined();
  });

  it('suppresses the hint when the query already spanned all projects', () => {
    expect(buildScopeHint(0, 3, true)).toBeUndefined();
  });

  it('suppresses the hint when results are empty but some were suppressed (finding #3)', () => {
    // The project HAS matching decisions — they all fell below the
    // suppression threshold. That is NOT "nothing was decided", so the
    // cross-project-retry advisory must not fire.
    expect(buildScopeHint(0, 3, false, 2)).toBeUndefined();
  });

  it('still emits the hint when both visible and suppressed counts are zero', () => {
    expect(buildScopeHint(0, 3, false, 0)).toBeDefined();
  });
});

describe('buildScopeEnvelope — all_projects with no active project (finding #2)', () => {
  it('emits active_project: null but enumerates accessible projects', () => {
    const env = buildScopeEnvelope({
      activeProjectId: null,
      accessibleProjects: [
        { id: 'A', name: 'Alpha' },
        { id: 'B', name: 'Beta' },
      ],
      queriedAllProjects: true,
    });
    expect(env.active_project).toBeNull();
    expect(env.accessible_projects).toHaveLength(2);
    expect(env.queried_all_projects).toBe(true);
  });
});
