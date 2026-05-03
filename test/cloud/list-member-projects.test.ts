/**
 * BUG #144 regression guard: `list_member_projects` RPC returns rows with
 * column names `project_id` / `project_name` / `project_role` / `decision_count`
 * (per supabase/migrations/004_multi_project.sql). The TS code MUST map them
 * to the public `ProjectInfo` shape (`id` / `name` / `role` / `decision_count`)
 * — the previous bare `as ProjectInfo[]` cast was a TypeScript lie that
 * silently produced rows where every `.id` was undefined, leading to
 * `match.any: [null, ...]` Qdrant filters that 400'd.
 */
import { describe, it, expect, vi } from 'vitest';
import { listMemberProjects } from '../../src/cloud/supabase.js';

function makeMockClient(rpcResult: { data: unknown; error: unknown }) {
  return {
    rpc: vi.fn().mockResolvedValue(rpcResult),
    from: vi.fn(),
  } as never;
}

describe('listMemberProjects', () => {
  it('maps RPC rows (project_id/project_name/project_role) to ProjectInfo (id/name/role)', async () => {
    const supabase = makeMockClient({
      data: [
        {
          project_id: '11111111-1111-1111-1111-111111111111',
          project_name: 'Alpha',
          project_role: 'admin',
          org_id: 'org-x',
          org_name: 'Org X',
          decision_count: 42,
        },
        {
          project_id: '22222222-2222-2222-2222-222222222222',
          project_name: 'Beta',
          project_role: 'member',
          org_id: 'org-x',
          org_name: 'Org X',
          decision_count: 7,
        },
      ],
      error: null,
    });

    const result = await listMemberProjects(supabase, 'mem-1');

    expect(result).toHaveLength(2);
    expect(result[0].id).toBe('11111111-1111-1111-1111-111111111111');
    expect(result[0].name).toBe('Alpha');
    expect(result[0].role).toBe('admin');
    expect(result[0].decision_count).toBe(42);
    expect(result[1].id).toBe('22222222-2222-2222-2222-222222222222');

    // Critical regression assertion: every id must be a real string, not undefined/null.
    // Without this mapping, downstream code does `projects.map(p => p.id)`
    // and gets `[undefined, undefined]`, which JSON-serializes as
    // `[null, null]` and breaks Qdrant filters.
    for (const p of result) {
      expect(p.id).toBeTruthy();
      expect(typeof p.id).toBe('string');
    }
  });

  it('returns empty array when RPC returns null data', async () => {
    const supabase = makeMockClient({ data: null, error: null });
    const result = await listMemberProjects(supabase, 'mem-1');
    expect(result).toEqual([]);
  });

  it('falls back to direct query when RPC errors', async () => {
    const fallbackData = [
      {
        project_id: 'fallback-1',
        role: 'admin',
        projects: { id: 'p1', name: 'Fallback Project' },
      },
    ];
    const supabase = {
      rpc: vi.fn().mockResolvedValue({ data: null, error: { message: 'rpc missing' } }),
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockResolvedValue({ data: fallbackData, error: null }),
        }),
      }),
    } as never;

    const result = await listMemberProjects(supabase, 'mem-1');
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('p1');
    expect(result[0].name).toBe('Fallback Project');
  });
});
