import { describe, it, expect, vi } from 'vitest';
import { canReadProject } from '../../src/lib/project-access.js';

type FakeProject = { id: string; visibility: 'public' | 'private' } | null;
type FakeMembership = { count: number; error?: { message: string } };

function makeSupabase(opts: {
  project: FakeProject | { error: { message: string } };
  membership?: FakeMembership;
}) {
  const projectResult =
    opts.project && 'error' in opts.project
      ? { data: null, error: opts.project.error }
      : { data: opts.project, error: null };

  const membership = opts.membership ?? { count: 0 };
  const membershipResult = membership.error
    ? { count: 0, error: membership.error }
    : { count: membership.count, error: null };

  // Minimal stub mimicking the Supabase builder chain used by the helper.
  const projectsChain = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue(projectResult),
  };
  const membersChain = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue(membershipResult),
  };

  return {
    from: vi.fn((table: string) => {
      if (table === 'projects') return projectsChain;
      if (table === 'project_members') return membersChain;
      throw new Error(`unexpected table ${table}`);
    }),
  } as unknown as Parameters<typeof canReadProject>[0];
}

describe('canReadProject', () => {
  const member = '11111111-1111-1111-1111-111111111111';
  const project = '22222222-2222-2222-2222-222222222222';

  it('returns true for a member of a private project', async () => {
    const sb = makeSupabase({
      project: { id: project, visibility: 'private' },
      membership: { count: 1 },
    });
    expect(await canReadProject(sb, member, project)).toBe(true);
  });

  it('returns true for a member of a public project', async () => {
    const sb = makeSupabase({
      project: { id: project, visibility: 'public' },
      membership: { count: 1 },
    });
    expect(await canReadProject(sb, member, project)).toBe(true);
  });

  it('returns true for a non-member of a public project', async () => {
    const sb = makeSupabase({
      project: { id: project, visibility: 'public' },
      membership: { count: 0 },
    });
    expect(await canReadProject(sb, member, project)).toBe(true);
  });

  it('returns false for a non-member of a private project', async () => {
    const sb = makeSupabase({
      project: { id: project, visibility: 'private' },
      membership: { count: 0 },
    });
    expect(await canReadProject(sb, member, project)).toBe(false);
  });

  it('returns false for a non-existent project (indistinguishable from private/non-member)', async () => {
    const sb = makeSupabase({
      project: null,
      membership: { count: 0 },
    });
    expect(await canReadProject(sb, member, project)).toBe(false);
  });

  it('returns false when the projects lookup errors (fail-closed)', async () => {
    const sb = makeSupabase({
      project: { error: { message: 'db unavailable' } },
      membership: { count: 1 },
    });
    expect(await canReadProject(sb, member, project)).toBe(false);
  });

  it('returns false when the membership lookup errors on a private project (fail-closed)', async () => {
    const sb = makeSupabase({
      project: { id: project, visibility: 'private' },
      membership: { count: 0, error: { message: 'membership query failed' } },
    });
    expect(await canReadProject(sb, member, project)).toBe(false);
  });

  it('does not consult the membership table when the project is public', async () => {
    // The public-flag short-circuits — even a membership-table error must not
    // prevent the read from succeeding. We assert this by passing a
    // membership error AND visibility=public and expecting true.
    const sb = makeSupabase({
      project: { id: project, visibility: 'public' },
      membership: { count: 0, error: { message: 'membership table down' } },
    });
    expect(await canReadProject(sb, member, project)).toBe(true);
  });

  it('returns false for empty caller member id', async () => {
    const sb = makeSupabase({
      project: { id: project, visibility: 'public' },
      membership: { count: 0 },
    });
    expect(await canReadProject(sb, '', project)).toBe(false);
  });

  it('returns false for empty target project id', async () => {
    const sb = makeSupabase({
      project: { id: project, visibility: 'public' },
      membership: { count: 0 },
    });
    expect(await canReadProject(sb, member, '')).toBe(false);
  });
});
