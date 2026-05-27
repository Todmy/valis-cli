/**
 * Tests for `valis_evolve` MCP tool (031/Track 5b).
 *
 * Mocks supabase + audit. Covers:
 *   - input validation (unknown edge type, self-reference)
 *   - cross-org safety: missing or other-org decisions yield the same
 *     "decision_not_found" error (no information leak)
 *   - happy path: edge insert + audit entry + response shape
 *   - audit failure is non-blocking (response still succeeds)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  fromMock,
  insertMock,
  selectMock,
  singleMock,
  createAuditEntryMock,
  getDecisionByIdMock,
  canWriteToProjectMock,
} = vi.hoisted(() => ({
  fromMock: vi.fn(),
  insertMock: vi.fn(),
  selectMock: vi.fn(),
  singleMock: vi.fn(),
  createAuditEntryMock: vi.fn(),
  getDecisionByIdMock: vi.fn(),
  canWriteToProjectMock: vi.fn(),
}));

vi.mock('../../../src/config/store.js', () => ({
  loadConfig: vi.fn().mockResolvedValue({
    org_id: 'org-1',
    member_id: 'm-1',
    author_name: 'tester',
    api_key: 'k',
    member_api_key: 'k',
    supabase_url: 'https://test.supabase.co',
    supabase_service_role_key: 'srk',
    qdrant_url: 'https://test.qdrant.io',
    qdrant_api_key: 'qk',
    auth_mode: 'service_role',
  }),
}));

vi.mock('../../../src/cloud/supabase.js', () => ({
  getSupabaseClient: vi.fn(() => ({ from: fromMock })),
  getSupabaseJwtClient: vi.fn(() => ({ from: fromMock })),
  getDecisionById: getDecisionByIdMock,
}));

vi.mock('../../../src/auth/audit.js', async () => {
  const actual = await vi.importActual<typeof import('../../../src/auth/audit.js')>(
    '../../../src/auth/audit.js',
  );
  return { ...actual, createAuditEntry: createAuditEntryMock };
});

vi.mock('../../../src/lib/project-access.js', () => ({
  canWriteToProject: canWriteToProjectMock,
  getServiceRoleSupabase: vi.fn(() => ({ from: fromMock })),
}));

import { handleEvolve } from '../../../src/mcp/tools/evolve.js';

beforeEach(() => {
  vi.clearAllMocks();
  createAuditEntryMock.mockResolvedValue(undefined);
  canWriteToProjectMock.mockResolvedValue(true);
  singleMock.mockResolvedValue({
    data: { id: 'edge-1', created_at: '2026-05-15T00:00:00Z' },
    error: null,
  });
  selectMock.mockReturnValue({ single: singleMock });
  insertMock.mockReturnValue({ select: selectMock });
  fromMock.mockReturnValue({ insert: insertMock });
});

describe('handleEvolve — input validation', () => {
  it('rejects an unknown edge type with allowed list', async () => {
    const result = await handleEvolve({
      from_id: 'a',
      to_id: 'b',
      type: 'frenemies',
    });
    expect('error' in result).toBe(true);
    if (!('error' in result)) return;
    expect(result.error).toBe('invalid_type');
    expect(result.allowed).toEqual([
      'supersedes',
      'builds_on',
      'synthesizes',
      'contradicts',
    ]);
    expect(getDecisionByIdMock).not.toHaveBeenCalled();
  });

  it('rejects from_id == to_id (self-reference, FR-008)', async () => {
    const result = await handleEvolve({
      from_id: 'same',
      to_id: 'same',
      type: 'supersedes',
    });
    expect('error' in result).toBe(true);
    if (!('error' in result)) return;
    expect(result.error).toBe('self_reference');
    expect(getDecisionByIdMock).not.toHaveBeenCalled();
  });
});

describe('handleEvolve — cross-org safety (FR-007)', () => {
  it('returns decision_not_found when from_id is missing — no row written', async () => {
    getDecisionByIdMock
      .mockResolvedValueOnce(null) // from_id lookup
      .mockResolvedValueOnce({ id: 'b' } as never); // to_id lookup

    const result = await handleEvolve({
      from_id: 'a-missing',
      to_id: 'b',
      type: 'supersedes',
    });

    expect('error' in result).toBe(true);
    if (!('error' in result)) return;
    expect(result.error).toBe('decision_not_found');
    expect(insertMock).not.toHaveBeenCalled();
    expect(createAuditEntryMock).not.toHaveBeenCalled();
  });

  it('returns decision_not_found when to_id is missing — same error wording as from-missing', async () => {
    // First call: from missing, to present.
    getDecisionByIdMock
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'b' } as never);
    const fromMissing = await handleEvolve({
      from_id: 'a-missing',
      to_id: 'b',
      type: 'supersedes',
    });

    // Second call: from present, to missing.
    getDecisionByIdMock
      .mockResolvedValueOnce({ id: 'a' } as never)
      .mockResolvedValueOnce(null);
    const toMissing = await handleEvolve({
      from_id: 'a',
      to_id: 'b-missing',
      type: 'supersedes',
    });

    // Both errors MUST be byte-identical (same status, same message) so the
    // response cannot be used as an oracle for cross-org existence.
    expect('error' in fromMissing && 'error' in toMissing).toBe(true);
    if ('error' in fromMissing && 'error' in toMissing) {
      expect(fromMissing.error).toBe('decision_not_found');
      expect(toMissing.error).toBe('decision_not_found');
      expect(fromMissing.message).toBe(toMissing.message);
    }
  });
});

describe('handleEvolve — happy path', () => {
  it('inserts an edge row, writes audit, returns response shape', async () => {
    getDecisionByIdMock
      .mockResolvedValueOnce({ id: 'a' } as never)
      .mockResolvedValueOnce({ id: 'b' } as never);

    const result = await handleEvolve({
      from_id: 'a',
      to_id: 'b',
      type: 'supersedes',
      reason: 'concurrent writes broke at 500 RPS',
    });

    expect('error' in result).toBe(false);
    if ('error' in result) return;
    expect(result.edge_id).toBe('edge-1');
    expect(result.from_id).toBe('a');
    expect(result.to_id).toBe('b');
    expect(result.type).toBe('supersedes');
    expect(result.reason).toBe('concurrent writes broke at 500 RPS');
    expect(result.created_at).toBe('2026-05-15T00:00:00Z');

    expect(insertMock).toHaveBeenCalledWith({
      org_id: 'org-1',
      from_id: 'a',
      to_id: 'b',
      type: 'supersedes',
      reason: 'concurrent writes broke at 500 RPS',
    });
    expect(createAuditEntryMock).toHaveBeenCalledTimes(1);
  });

  it('coerces empty/whitespace reason to null', async () => {
    getDecisionByIdMock
      .mockResolvedValueOnce({ id: 'a' } as never)
      .mockResolvedValueOnce({ id: 'b' } as never);

    const result = await handleEvolve({
      from_id: 'a',
      to_id: 'b',
      type: 'builds_on',
      reason: '   ',
    });

    expect('error' in result).toBe(false);
    if ('error' in result) return;
    expect(result.reason).toBe(null);
    expect(insertMock).toHaveBeenCalledWith(
      expect.objectContaining({ reason: null }),
    );
  });

  it('audit failure does NOT break the response', async () => {
    getDecisionByIdMock
      .mockResolvedValueOnce({ id: 'a' } as never)
      .mockResolvedValueOnce({ id: 'b' } as never);
    createAuditEntryMock.mockRejectedValueOnce(new Error('audit table locked'));

    const result = await handleEvolve({
      from_id: 'a',
      to_id: 'b',
      type: 'synthesizes',
    });

    expect('error' in result).toBe(false);
    if ('error' in result) return;
    expect(result.edge_id).toBe('edge-1');
  });
});

describe('handleEvolve — write failure', () => {
  it('returns write_failed when supabase insert errors', async () => {
    getDecisionByIdMock
      .mockResolvedValueOnce({ id: 'a' } as never)
      .mockResolvedValueOnce({ id: 'b' } as never);
    singleMock.mockResolvedValueOnce({
      data: null,
      error: { message: 'unique constraint violation on (from_id, to_id, type)' },
    });

    const result = await handleEvolve({
      from_id: 'a',
      to_id: 'b',
      type: 'contradicts',
    });

    expect('error' in result).toBe(true);
    if (!('error' in result)) return;
    expect(result.error).toBe('write_failed');
    expect(result.message).toMatch(/unique constraint/);
    expect(createAuditEntryMock).not.toHaveBeenCalled();
  });
});

describe('handleEvolve — project_id scoping (issue #54 sibling)', () => {
  // Cross-org case: both decisions live in a project whose owning org
  // differs from the caller's auth-resolved org_id (typical OAuth plugin
  // path after PR #55 fixes #54 for update_outcome/lifecycle/store but
  // left valis_evolve as known-limitation).

  it('rejects with project_access_denied when caller is not a project member', async () => {
    canWriteToProjectMock.mockResolvedValueOnce(false);

    const result = await handleEvolve({
      from_id: 'a',
      to_id: 'b',
      type: 'builds_on',
      project_id: 'project-mojob',
    });

    expect('error' in result).toBe(true);
    if (!('error' in result)) return;
    expect(result.error).toBe('project_access_denied');
    // Critical: precheck blocks BEFORE any decision lookup or write.
    expect(getDecisionByIdMock).not.toHaveBeenCalled();
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('passes project_id to both getDecisionById calls when membership ok', async () => {
    canWriteToProjectMock.mockResolvedValueOnce(true);
    getDecisionByIdMock
      .mockResolvedValueOnce({ id: 'a', org_id: 'mojob-org', project_id: 'project-mojob' } as never)
      .mockResolvedValueOnce({ id: 'b', org_id: 'mojob-org', project_id: 'project-mojob' } as never);

    await handleEvolve({
      from_id: 'a',
      to_id: 'b',
      type: 'supersedes',
      project_id: 'project-mojob',
    });

    // Load-bearing: 4th arg (project_id) signals project-scoped lookup
    // for BOTH endpoints. Without this, cross-org rows never match.
    expect(getDecisionByIdMock).toHaveBeenCalledWith(
      expect.any(Object),
      'org-1',
      'a',
      'project-mojob',
    );
    expect(getDecisionByIdMock).toHaveBeenCalledWith(
      expect.any(Object),
      'org-1',
      'b',
      'project-mojob',
    );
  });

  it('inserts edge with the resolved (project) org_id, NOT caller config.org_id', async () => {
    canWriteToProjectMock.mockResolvedValueOnce(true);
    getDecisionByIdMock
      .mockResolvedValueOnce({ id: 'a', org_id: 'mojob-org', project_id: 'project-mojob' } as never)
      .mockResolvedValueOnce({ id: 'b', org_id: 'mojob-org', project_id: 'project-mojob' } as never);

    await handleEvolve({
      from_id: 'a',
      to_id: 'b',
      type: 'supersedes',
      project_id: 'project-mojob',
    });

    // The edge row must land under the same org as the decisions it
    // links — not the caller's auth-resolved personal org.
    expect(insertMock).toHaveBeenCalledWith(
      expect.objectContaining({
        org_id: 'mojob-org',
        from_id: 'a',
        to_id: 'b',
        type: 'supersedes',
      }),
    );
    expect(insertMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ org_id: 'org-1' }),
    );
  });

  it('preserves legacy org_id-scoped lookup when project_id is absent', async () => {
    getDecisionByIdMock
      .mockResolvedValueOnce({ id: 'a', org_id: 'org-1' } as never)
      .mockResolvedValueOnce({ id: 'b', org_id: 'org-1' } as never);

    await handleEvolve({
      from_id: 'a',
      to_id: 'b',
      type: 'builds_on',
    });

    // No project_id → no membership check, legacy 3-arg getDecisionById.
    expect(canWriteToProjectMock).not.toHaveBeenCalled();
    expect(getDecisionByIdMock).toHaveBeenCalledWith(
      expect.any(Object),
      'org-1',
      'a',
      null,
    );
    // Edge org_id falls back to config.org_id (legacy behavior).
    expect(insertMock).toHaveBeenCalledWith(
      expect.objectContaining({ org_id: 'org-1' }),
    );
  });
});
