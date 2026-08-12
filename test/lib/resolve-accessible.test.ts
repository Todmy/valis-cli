/**
 * gh#322 — turns a candidate id list into the subset the caller may actually
 * read. Fails closed: a lookup failure yields an empty set, never a partial or
 * optimistic one (gh#324 is what the optimistic version costs).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockListMemberProjects = vi.fn();
const mockCanReadProject = vi.fn();

vi.mock('../../src/cloud/supabase.js', () => ({
  listMemberProjects: (...a: unknown[]) => mockListMemberProjects(...a),
}));

vi.mock('../../src/lib/project-access.js', () => ({
  canReadProject: (...a: unknown[]) => mockCanReadProject(...a),
}));

import { resolveAccessibleProjectIds } from '../../src/lib/resolve-accessible.js';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const PUBLIC = '33333333-3333-4333-8333-333333333333';
const PRIVATE = '44444444-4444-4444-8444-444444444444';

const sb = {} as never;

beforeEach(() => {
  vi.clearAllMocks();
  mockListMemberProjects.mockResolvedValue([
    { id: A, name: 'A' },
    { id: B, name: 'B' },
  ]);
});

describe('resolveAccessibleProjectIds', () => {
  it('returns member projects without any canReadProject call', async () => {
    const ids = await resolveAccessibleProjectIds(sb, 'mem-1', [A, B]);
    expect(ids).toEqual([A, B]);
    expect(mockCanReadProject).not.toHaveBeenCalled();
  });

  it('adds a public cross-org candidate via canReadProject', async () => {
    mockCanReadProject.mockResolvedValueOnce(true);
    const ids = await resolveAccessibleProjectIds(sb, 'mem-1', [A, PUBLIC]);
    expect(ids).toContain(PUBLIC);
    expect(mockCanReadProject).toHaveBeenCalledTimes(1);
  });

  it('does not add a private cross-org candidate', async () => {
    mockCanReadProject.mockResolvedValueOnce(false);
    const ids = await resolveAccessibleProjectIds(sb, 'mem-1', [A, PRIVATE]);
    expect(ids).not.toContain(PRIVATE);
  });

  it('returns an empty list when listMemberProjects throws, not a partial one', async () => {
    mockListMemberProjects.mockRejectedValueOnce(new Error('access denied'));
    const ids = await resolveAccessibleProjectIds(sb, 'mem-1', [A, B]);
    expect(ids).toEqual([]);
    expect(mockCanReadProject).not.toHaveBeenCalled();
  });

  it('leaves the other ids intact when canReadProject throws on one', async () => {
    mockCanReadProject.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce(true);
    const ids = await resolveAccessibleProjectIds(sb, 'mem-1', [A, PRIVATE, PUBLIC]);
    expect(ids).toContain(A);
    expect(ids).toContain(PUBLIC);
    expect(ids).not.toContain(PRIVATE);
  });

  it('checks each non-member candidate exactly once even when repeated', async () => {
    mockCanReadProject.mockResolvedValue(true);
    await resolveAccessibleProjectIds(sb, 'mem-1', [PUBLIC, PUBLIC, PUBLIC]);
    expect(mockCanReadProject).toHaveBeenCalledTimes(1);
  });

  it('makes no canReadProject calls for an empty candidate list', async () => {
    const ids = await resolveAccessibleProjectIds(sb, 'mem-1', []);
    expect(ids).toEqual([A, B]);
    expect(mockCanReadProject).not.toHaveBeenCalled();
  });

  it('returns an empty list for a missing memberId without calling out', async () => {
    const ids = await resolveAccessibleProjectIds(sb, '', [A]);
    expect(ids).toEqual([]);
    expect(mockListMemberProjects).not.toHaveBeenCalled();
  });
});
