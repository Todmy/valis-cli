/**
 * gh#322 — scope resolution is the whole correctness surface of multi-project
 * reads, and the place a cross-project leak was reproduced on 2026-05-21
 * (decision a7cc9e9f). Keeping it pure is what makes it exhaustively testable.
 */

import { describe, it, expect } from 'vitest';
import { resolveReadScope, type ReadScopeInput } from '../../src/lib/read-scope.js';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';
const STALE = '99999999-9999-4999-8999-999999999999';

function input(over: Partial<ReadScopeInput> = {}): ReadScopeInput {
  return {
    activeProjectId: A,
    linkedProjectIds: [],
    allProjects: false,
    accessibleProjectIds: [A, B, C],
    ...over,
  };
}

describe('resolveReadScope — precedence', () => {
  it('requested ids win over linked and over allProjects', () => {
    const r = resolveReadScope(
      input({ requestedProjectIds: [B], linkedProjectIds: [C], allProjects: true }),
    );
    expect(r.searched).toEqual([B]);
  });

  it('linked projects widen the scope when no argument is passed', () => {
    const r = resolveReadScope(input({ linkedProjectIds: [B] }));
    expect(r.searched).toEqual([A, B]);
  });

  it('active project alone when linked is empty', () => {
    expect(resolveReadScope(input()).searched).toEqual([A]);
  });

  it('allProjects expands to the full accessible list', () => {
    const r = resolveReadScope(input({ allProjects: true }));
    expect(r.searched).toEqual([A, B, C]);
  });

  it('an empty requestedProjectIds array does not win over linked', () => {
    const r = resolveReadScope(input({ requestedProjectIds: [], linkedProjectIds: [B] }));
    expect(r.searched).toEqual([A, B]);
  });
});

describe('resolveReadScope — refusal', () => {
  it('allProjects with an empty accessible list errors, never widens', () => {
    const r = resolveReadScope(input({ allProjects: true, accessibleProjectIds: [] }));
    expect(r.searched).toEqual([]);
    expect(r.error).toBe('project_scope_required');
  });

  it('an inaccessible requested id lands in denied and not in searched', () => {
    const r = resolveReadScope(input({ requestedProjectIds: [B, STALE] }));
    expect(r.searched).toEqual([B]);
    expect(r.denied).toEqual([STALE]);
    expect(r.error).toBeUndefined();
  });

  it('a stale linked id is denied while the rest still search', () => {
    const r = resolveReadScope(input({ linkedProjectIds: [B, STALE] }));
    expect(r.searched).toEqual([A, B]);
    expect(r.denied).toEqual([STALE]);
  });

  it('empty everything errors with project_scope_required', () => {
    const r = resolveReadScope(input({ activeProjectId: null, accessibleProjectIds: [] }));
    expect(r.error).toBe('project_scope_required');
  });

  it('a fully denied request errors rather than returning an empty search', () => {
    const r = resolveReadScope(input({ requestedProjectIds: [STALE] }));
    expect(r.searched).toEqual([]);
    expect(r.denied).toEqual([STALE]);
    expect(r.error).toBe('project_scope_required');
  });

  it('no candidates produce an empty denied, not a synthetic entry', () => {
    const r = resolveReadScope(input({ activeProjectId: null }));
    expect(r.denied).toEqual([]);
  });
});

describe('resolveReadScope — write target', () => {
  it('writeTarget stays the active project when the read spans several projects', () => {
    const r = resolveReadScope(input({ linkedProjectIds: [B, C] }));
    expect(r.searched).toEqual([A, B, C]);
    expect(r.writeTarget).toBe(A);
  });

  it('writeTarget is null when no active project and searched comes from requested ids', () => {
    const r = resolveReadScope(input({ activeProjectId: null, requestedProjectIds: [B] }));
    expect(r.writeTarget).toBeNull();
    expect(r.searched).toEqual([B]);
  });

  it('writeTarget is unaffected by allProjects', () => {
    expect(resolveReadScope(input({ allProjects: true })).writeTarget).toBe(A);
  });
});

describe('resolveReadScope — deduplication and order', () => {
  it('the active id duplicated in linked appears once in searched', () => {
    const r = resolveReadScope(input({ linkedProjectIds: [A, B] }));
    expect(r.searched).toEqual([A, B]);
  });

  it('a repeated denied id is reported once', () => {
    const r = resolveReadScope(input({ requestedProjectIds: [STALE, STALE, B] }));
    expect(r.denied).toEqual([STALE]);
  });

  it('the active project sorts first when present', () => {
    const r = resolveReadScope(input({ activeProjectId: C, linkedProjectIds: [A, B] }));
    expect(r.searched[0]).toBe(C);
  });
});

describe('resolveReadScope — invariants across every fixture', () => {
  const fixtures: ReadScopeInput[] = [
    input(),
    input({ linkedProjectIds: [B] }),
    input({ allProjects: true }),
    input({ allProjects: true, accessibleProjectIds: [] }),
    input({ requestedProjectIds: [B, STALE] }),
    input({ requestedProjectIds: [STALE] }),
    input({ activeProjectId: null }),
    input({ activeProjectId: null, requestedProjectIds: [B] }),
    input({ linkedProjectIds: [A, B, STALE] }),
    input({ requestedProjectIds: [], linkedProjectIds: [] }),
  ];

  it('never returns a searched id outside accessibleProjectIds', () => {
    for (const f of fixtures) {
      const r = resolveReadScope(f);
      for (const id of r.searched) {
        expect(f.accessibleProjectIds).toContain(id);
      }
    }
  });

  it('never returns an empty searched without the error', () => {
    for (const f of fixtures) {
      const r = resolveReadScope(f);
      if (r.searched.length === 0) expect(r.error).toBe('project_scope_required');
    }
  });

  it('never returns the error alongside a populated searched', () => {
    for (const f of fixtures) {
      const r = resolveReadScope(f);
      if (r.error) expect(r.searched).toEqual([]);
    }
  });

  it('always reports writeTarget as the active project, whatever the read scope', () => {
    for (const f of fixtures) {
      expect(resolveReadScope(f).writeTarget).toBe(f.activeProjectId);
    }
  });

  it('never mutates its input', () => {
    for (const f of fixtures) {
      const snapshot = JSON.stringify(f);
      resolveReadScope(f);
      expect(JSON.stringify(f)).toBe(snapshot);
    }
  });
});
