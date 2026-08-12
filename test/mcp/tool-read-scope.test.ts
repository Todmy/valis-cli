/**
 * gh#322 review Finding 1 — `resolveToolReadScope` must not widen the read
 * scope when the membership lookup FAILS while credentials are present.
 *
 * `resolveAllAccessibleProjects` returns `[]` for three different reasons:
 * no member_id, no usable Supabase client, and `listMemberProjects` throwing.
 * Treating the third like the second accepts an unverified `project_ids`
 * argument as accessible — the exact ambiguity gh#324 was fixed to eliminate.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/cloud/supabase.js', () => ({
  getSupabaseClient: vi.fn(() => ({}) as never),
  getSupabaseJwtClient: vi.fn(() => ({}) as never),
  getProjectName: vi.fn(async () => null),
  listMemberProjects: vi.fn(),
}));

vi.mock('../../src/lib/project-access.js', () => ({
  canReadProject: vi.fn(),
}));

import { resolveToolReadScope } from '../../src/mcp/tools/scope.js';
import { listMemberProjects } from '../../src/cloud/supabase.js';
import { canReadProject } from '../../src/lib/project-access.js';
import type { ServerConfig, ValisConfig } from '../../src/types.js';

const CONFIG = {
  member_id: 'member-1',
  supabase_url: 'https://example.supabase.co',
  supabase_service_role_key: 'service-role-key',
} as unknown as ValisConfig;

/** Server mode: a service-role client is always available. */
const OVERRIDE = { project_id: 'own-project' } as unknown as ServerConfig;

describe('resolveToolReadScope — membership lookup failure must not widen (Finding 1)', () => {
  beforeEach(() => {
    vi.mocked(listMemberProjects).mockReset();
    vi.mocked(canReadProject).mockReset();
  });

  it('denies a requested outsider project when listMemberProjects throws', async () => {
    vi.mocked(listMemberProjects).mockRejectedValue(new Error('transient supabase error'));
    // Access is genuinely absent — the gate must be consulted, not skipped.
    vi.mocked(canReadProject).mockResolvedValue(false);

    const scope = await resolveToolReadScope({
      config: CONFIG,
      configOverride: OVERRIDE,
      activeProjectId: 'own-project',
      linkedProjectIds: [],
      requestedProjectIds: ['other-org-project'],
      allProjects: false,
    });

    expect(scope.searched).not.toContain('other-org-project');
    expect(scope.denied).toContain('other-org-project');
  });

  it('consults canReadProject rather than trusting the declared list', async () => {
    vi.mocked(listMemberProjects).mockRejectedValue(new Error('transient supabase error'));
    vi.mocked(canReadProject).mockResolvedValue(false);

    await resolveToolReadScope({
      config: CONFIG,
      configOverride: OVERRIDE,
      activeProjectId: 'own-project',
      linkedProjectIds: ['linked-project'],
      requestedProjectIds: [],
      allProjects: false,
    });

    const checked = vi.mocked(canReadProject).mock.calls.map((c) => c[2]);
    expect(checked).toContain('linked-project');
  });

  it('still degrades open when NO client can be built (plain CLI stdio)', async () => {
    // No service-role key and no jwt mode → selectMemberSupabaseClient returns
    // null. The declared ids are the repo's own committed .valis.json, and the
    // org_id filter still bounds the query — this path is unchanged.
    const stdio = { member_id: 'member-1', supabase_url: 'https://x.supabase.co' } as unknown as ValisConfig;

    const scope = await resolveToolReadScope({
      config: stdio,
      configOverride: undefined,
      activeProjectId: 'own-project',
      linkedProjectIds: ['linked-project'],
      requestedProjectIds: [],
      allProjects: false,
    });

    expect(scope.searched).toEqual(['own-project', 'linked-project']);
    expect(scope.denied).toEqual([]);
  });

  it('keeps all_projects failing closed when the membership lookup throws', async () => {
    vi.mocked(listMemberProjects).mockRejectedValue(new Error('transient supabase error'));

    const scope = await resolveToolReadScope({
      config: CONFIG,
      configOverride: OVERRIDE,
      activeProjectId: 'own-project',
      linkedProjectIds: [],
      requestedProjectIds: [],
      allProjects: true,
    });

    expect(scope.searched).toEqual([]);
    expect(scope.error).toBe('project_scope_required');
  });
});
