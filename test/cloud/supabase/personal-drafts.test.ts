import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  PERSONAL_DRAFTS_NAME,
  PERSONAL_DRAFTS_SENTINEL,
  ensurePersonalDrafts,
  fetchPersonalDrafts,
  promoteDraftToProject,
  archiveDraft,
  deleteDraft,
  restoreDraft,
  listActiveDrafts,
} from '../../../src/cloud/supabase/personal-drafts.js';

vi.mock('../../../src/cloud/supabase/audit.js', () => ({
  storeAuditEntry: vi.fn().mockResolvedValue({}),
}));

import { storeAuditEntry } from '../../../src/cloud/supabase/audit.js';

/**
 * 034 / T031 — unit tests for the personal-drafts cloud helper layer.
 * Builds an inline mock that satisfies the chained-builder shape used
 * by @supabase/supabase-js (eq / select / single / maybeSingle / update
 * / insert / delete). Each test installs the chain it needs, asserts
 * the SQL-equivalent intent (which table, which filters, which writes).
 */

interface MockQuery {
  eq: ReturnType<typeof vi.fn>;
  select: ReturnType<typeof vi.fn>;
  single: ReturnType<typeof vi.fn>;
  maybeSingle: ReturnType<typeof vi.fn>;
  insert: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
  order: ReturnType<typeof vi.fn>;
}

function makeChain(opts: {
  finalData?: unknown;
  finalError?: unknown;
} = {}): MockQuery {
  const chain: MockQuery = {
    eq: vi.fn(),
    select: vi.fn(),
    single: vi.fn(),
    maybeSingle: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    order: vi.fn(),
  };
  const resolved = { data: opts.finalData ?? null, error: opts.finalError ?? null };
  // Every builder method returns the same chain object; terminators
  // (single / maybeSingle / order) and write-shortcut combos resolve
  // to the same {data, error}.
  chain.eq.mockReturnValue(chain);
  chain.select.mockReturnValue(chain);
  chain.insert.mockReturnValue(chain);
  chain.update.mockReturnValue(chain);
  chain.delete.mockReturnValue(chain);
  chain.order.mockResolvedValue(resolved);
  chain.single.mockResolvedValue(resolved);
  chain.maybeSingle.mockResolvedValue(resolved);
  // Direct-await on delete/insert/update without .select() still resolves.
  Object.defineProperty(chain.delete, 'then', {
    value: (resolver: (v: unknown) => unknown) => resolver(resolved),
  });
  return chain;
}

function makeSupabaseMock(chainByTable: Record<string, MockQuery>) {
  return {
    from: vi.fn((table: string) => {
      if (!chainByTable[table]) {
        throw new Error(`Unexpected table access in mock: ${table}`);
      }
      return chainByTable[table];
    }),
  } as unknown as Parameters<typeof ensurePersonalDrafts>[0];
}

describe('personal-drafts helpers — constants', () => {
  it('exposes the canonical name + sentinel as readonly constants', () => {
    expect(PERSONAL_DRAFTS_NAME).toBe('Personal Drafts');
    expect(PERSONAL_DRAFTS_SENTINEL).toBe('personal-drafts');
  });
});

describe('ensurePersonalDrafts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns existing row when one is found (created: false)', async () => {
    const chain = makeChain({
      finalData: {
        id: 'pd-1',
        org_id: 'o',
        owner_member_id: 'm',
        name: PERSONAL_DRAFTS_NAME,
        is_personal_drafts: true,
      },
    });
    const supabase = makeSupabaseMock({ projects: chain });

    const result = await ensurePersonalDrafts(supabase, 'o', 'm');
    expect(result).toEqual({ projectId: 'pd-1', created: false });
    expect(chain.eq).toHaveBeenCalledWith('org_id', 'o');
    expect(chain.eq).toHaveBeenCalledWith('owner_member_id', 'm');
    expect(chain.eq).toHaveBeenCalledWith('is_personal_drafts', true);
  });

  it('inserts a new row when fetch returns null (created: true)', async () => {
    // First call (fetch) returns null; second call (insert) returns the new id.
    const fetchChain = makeChain({ finalData: null });
    const insertChain = makeChain({ finalData: { id: 'pd-new' } });
    let callCount = 0;
    const supabase = {
      from: vi.fn((table: string) => {
        if (table !== 'projects') throw new Error('wrong table');
        callCount += 1;
        return callCount === 1 ? fetchChain : insertChain;
      }),
    } as unknown as Parameters<typeof ensurePersonalDrafts>[0];

    const result = await ensurePersonalDrafts(supabase, 'o', 'm');
    expect(result).toEqual({ projectId: 'pd-new', created: true });
    expect(insertChain.insert).toHaveBeenCalledWith({
      org_id: 'o',
      name: PERSONAL_DRAFTS_NAME,
      is_personal_drafts: true,
      owner_member_id: 'm',
    });
  });

  it('on 23505 unique_violation re-fetches and returns the racer-won row', async () => {
    const fetchOneChain = makeChain({ finalData: null });
    const insertChain = makeChain({ finalError: { code: '23505', message: 'unique violation' } });
    const fetchTwoChain = makeChain({
      finalData: { id: 'pd-race', org_id: 'o', owner_member_id: 'm', is_personal_drafts: true, name: PERSONAL_DRAFTS_NAME },
    });
    let callCount = 0;
    const supabase = {
      from: vi.fn(() => {
        callCount += 1;
        return [fetchOneChain, insertChain, fetchTwoChain][callCount - 1];
      }),
    } as unknown as Parameters<typeof ensurePersonalDrafts>[0];

    const result = await ensurePersonalDrafts(supabase, 'o', 'm');
    expect(result).toEqual({ projectId: 'pd-race', created: false });
  });

  it('re-throws non-23505 errors with a descriptive message', async () => {
    const fetchChain = makeChain({ finalData: null });
    const insertChain = makeChain({ finalError: { code: '42501', message: 'permission denied' } });
    let callCount = 0;
    const supabase = {
      from: vi.fn(() => {
        callCount += 1;
        return callCount === 1 ? fetchChain : insertChain;
      }),
    } as unknown as Parameters<typeof ensurePersonalDrafts>[0];

    await expect(ensurePersonalDrafts(supabase, 'o', 'm')).rejects.toThrow(/permission denied/);
  });
});

describe('fetchPersonalDrafts', () => {
  it('queries projects with the three RLS-aligned predicates', async () => {
    const chain = makeChain({ finalData: null });
    const supabase = makeSupabaseMock({ projects: chain });

    await fetchPersonalDrafts(supabase, 'org-a', 'mem-b');
    expect(chain.eq).toHaveBeenCalledWith('org_id', 'org-a');
    expect(chain.eq).toHaveBeenCalledWith('owner_member_id', 'mem-b');
    expect(chain.eq).toHaveBeenCalledWith('is_personal_drafts', true);
    expect(chain.maybeSingle).toHaveBeenCalled();
  });

  it('returns null when no row matches', async () => {
    const chain = makeChain({ finalData: null });
    const supabase = makeSupabaseMock({ projects: chain });
    const result = await fetchPersonalDrafts(supabase, 'o', 'm');
    expect(result).toBeNull();
  });
});

describe('promoteDraftToProject', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('updates decision project_id and writes audit_entries row', async () => {
    const updateChain = makeChain();
    const supabase = makeSupabaseMock({ decisions: updateChain });

    await promoteDraftToProject(supabase, {
      decisionId: 'd-1',
      sourcePersonalDraftsProjectId: 'pd-1',
      targetProjectId: 'team-x',
      targetProjectName: 'Team X',
      actingMemberId: 'm-1',
      orgId: 'o-1',
    });

    expect(updateChain.update).toHaveBeenCalledWith({ project_id: 'team-x' });
    expect(updateChain.eq).toHaveBeenCalledWith('id', 'd-1');
    expect(updateChain.eq).toHaveBeenCalledWith('project_id', 'pd-1');
    expect(storeAuditEntry).toHaveBeenCalledTimes(1);
    const [, entry] = vi.mocked(storeAuditEntry).mock.calls[0];
    expect(entry.action).toBe('personal_drafts_promoted');
    expect(entry.target_id).toBe('d-1');
    expect(entry.project_id).toBe('pd-1');
    expect(entry.new_state).toMatchObject({
      target_project_id: 'team-x',
      target_project_name: 'Team X',
    });
  });
});

describe('archiveDraft / deleteDraft / restoreDraft / listActiveDrafts', () => {
  it('archiveDraft sets status archived', async () => {
    const chain = makeChain();
    const supabase = makeSupabaseMock({ decisions: chain });
    const result = await archiveDraft(supabase, 'd-1');
    expect(chain.update).toHaveBeenCalledWith({ status: 'archived' });
    expect(chain.eq).toHaveBeenCalledWith('id', 'd-1');
    expect(result).toEqual({ status: 'archived' });
  });

  it('deleteDraft issues DELETE on decisions', async () => {
    const chain = makeChain();
    const supabase = makeSupabaseMock({ decisions: chain });
    await deleteDraft(supabase, 'd-1');
    expect(chain.delete).toHaveBeenCalled();
    expect(chain.eq).toHaveBeenCalledWith('id', 'd-1');
  });

  it('restoreDraft flips archived → active when row matches', async () => {
    const chain = makeChain({ finalData: { id: 'd-1' } });
    const supabase = makeSupabaseMock({ decisions: chain });
    const result = await restoreDraft(supabase, 'd-1');
    expect(chain.update).toHaveBeenCalledWith({ status: 'active' });
    expect(chain.eq).toHaveBeenCalledWith('id', 'd-1');
    expect(chain.eq).toHaveBeenCalledWith('status', 'archived');
    expect(result).toEqual({ id: 'd-1', status: 'active' });
  });

  it('restoreDraft returns null when nothing matches (not-archived OR not-owned)', async () => {
    const chain = makeChain({ finalData: null });
    const supabase = makeSupabaseMock({ decisions: chain });
    const result = await restoreDraft(supabase, 'd-x');
    expect(result).toBeNull();
  });

  it('listActiveDrafts queries active rows ordered oldest-first', async () => {
    const chain = makeChain({ finalData: [{ id: 'd-1', type: 'lesson', summary: null, text: 't', created_at: '2026-05-27' }] });
    const supabase = makeSupabaseMock({ decisions: chain });
    const result = await listActiveDrafts(supabase, 'pd-1');
    expect(chain.eq).toHaveBeenCalledWith('project_id', 'pd-1');
    expect(chain.eq).toHaveBeenCalledWith('status', 'active');
    expect(chain.order).toHaveBeenCalledWith('created_at', { ascending: true });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('d-1');
  });
});
