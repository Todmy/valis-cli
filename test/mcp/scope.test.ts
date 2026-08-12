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

// gh#322 — the read scope is reported explicitly. `active_project` is the
// write target; `searched_projects` is what the query actually covered.
describe('buildScopeEnvelope — read scope (gh#322)', () => {
  const accessible = [
    { id: 'A', name: 'Alpha' },
    { id: 'B', name: 'Beta' },
  ];

  it('names every id that was queried in searched_projects', () => {
    const env = buildScopeEnvelope({
      activeProjectId: 'A',
      accessibleProjects: accessible,
      queriedAllProjects: false,
      searchedProjectIds: ['A', 'B'],
    });
    expect(env.searched_projects).toEqual([
      { id: 'A', name: 'Alpha' },
      { id: 'B', name: 'Beta' },
    ]);
  });

  it('omits denied_projects when nothing was denied', () => {
    const env = buildScopeEnvelope({
      activeProjectId: 'A',
      accessibleProjects: accessible,
      queriedAllProjects: false,
      searchedProjectIds: ['A'],
    });
    expect(env.denied_projects).toBeUndefined();
  });

  it('lists refused ids in denied_projects when present', () => {
    const env = buildScopeEnvelope({
      activeProjectId: 'A',
      accessibleProjects: accessible,
      queriedAllProjects: false,
      searchedProjectIds: ['A'],
      deniedProjectIds: ['Z'],
    });
    expect(env.denied_projects).toEqual(['Z']);
  });

  it('still names the write target in active_project on a multi-project read', () => {
    const env = buildScopeEnvelope({
      activeProjectId: 'A',
      accessibleProjects: accessible,
      queriedAllProjects: false,
      searchedProjectIds: ['A', 'B'],
    });
    expect(env.active_project).toEqual({ id: 'A', name: 'Alpha' });
  });

  it('reports an id with no known name using the id itself, not dropping it', () => {
    const env = buildScopeEnvelope({
      activeProjectId: 'A',
      accessibleProjects: accessible,
      queriedAllProjects: false,
      searchedProjectIds: ['A', 'unnamed-id'],
    });
    expect(env.searched_projects).toEqual([
      { id: 'A', name: 'Alpha' },
      { id: 'unnamed-id', name: 'unnamed-id' },
    ]);
  });

  it('defaults searched_projects to the active project when no list is given', () => {
    const env = buildScopeEnvelope({
      activeProjectId: 'A',
      accessibleProjects: accessible,
      queriedAllProjects: false,
    });
    expect(env.searched_projects).toEqual([{ id: 'A', name: 'Alpha' }]);
  });
});
