/**
 * Tests for `valis_update_outcome` MCP tool (028-phase13/Track 5a).
 *
 * Two surfaces under test:
 *   1. `normaliseOutcome` — pure typo-tolerance lookup (FR-008)
 *   2. `handleUpdateOutcome` — write-path orchestration (FR-007..FR-012)
 *
 * Supabase and Qdrant clients are mocked so the test focuses on the
 * branching: invalid input rejected before DB call, missing decision
 * surfaces a structured error, happy path persists + audits + syncs Qdrant.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/config/store.js', () => ({
  loadConfig: vi.fn().mockResolvedValue({
    org_id: 'test-org-id',
    member_id: 'test-member-id',
    api_key: 'tm_test',
    member_api_key: 'tm_test_member',
    author_name: 'tester',
    supabase_url: 'https://test.supabase.co',
    supabase_service_role_key: 'test-srk',
    qdrant_url: 'https://test.qdrant.io',
    qdrant_api_key: 'test-qkey',
    auth_mode: 'service_role',
  }),
}));

// All mock fns referenced from inside vi.mock() factories must be hoisted —
// the factories run BEFORE module-level `const` initialisation, so direct
// `const x = vi.fn()` at module scope is undefined at factory time.
const {
  fromMock,
  updateMock,
  eqMock1,
  eqMock2,
  setDecisionPayloadMock,
  createAuditEntryMock,
  getDecisionByIdMock,
  canWriteToProjectMock,
} = vi.hoisted(() => ({
  fromMock: vi.fn(),
  updateMock: vi.fn(),
  eqMock1: vi.fn(),
  eqMock2: vi.fn(),
  setDecisionPayloadMock: vi.fn(),
  createAuditEntryMock: vi.fn(),
  getDecisionByIdMock: vi.fn(),
  canWriteToProjectMock: vi.fn(),
}));

vi.mock('../../../src/cloud/supabase.js', () => ({
  getSupabaseClient: vi.fn(() => ({ from: fromMock })),
  getSupabaseJwtClient: vi.fn(() => ({ from: fromMock })),
  getDecisionById: getDecisionByIdMock,
}));

vi.mock('../../../src/cloud/qdrant.js', () => ({
  getQdrantClient: vi.fn(() => ({})),
}));

vi.mock('../../../src/cloud/qdrant/decisions.js', () => ({
  setDecisionPayload: setDecisionPayloadMock,
}));

vi.mock('../../../src/auth/audit.js', async () => {
  const actual = await vi.importActual<
    typeof import('../../../src/auth/audit.js')
  >('../../../src/auth/audit.js');
  return {
    ...actual,
    createAuditEntry: createAuditEntryMock,
  };
});

vi.mock('../../../src/lib/project-access.js', () => ({
  canWriteToProject: canWriteToProjectMock,
  // PR #57: getServiceRoleSupabase is the typed factory used by the handler
  // when args.project_id is given. Tests share one chainable mock for both
  // JWT and service-role paths — returning the same `from` mock is fine.
  getServiceRoleSupabase: vi.fn(() => ({ from: fromMock })),
}));

import {
  handleUpdateOutcome,
  normaliseOutcome,
  CANONICAL_OUTCOMES,
} from '../../../src/mcp/tools/update-outcome.js';

beforeEach(() => {
  vi.clearAllMocks();
  setDecisionPayloadMock.mockResolvedValue(undefined);
  createAuditEntryMock.mockResolvedValue(undefined);
  canWriteToProjectMock.mockResolvedValue(true);
  // Default chainable: .from('decisions').update({...}).eq().eq() → { error: null }
  eqMock2.mockResolvedValue({ error: null });
  eqMock1.mockReturnValue({ eq: eqMock2 });
  updateMock.mockReturnValue({ eq: eqMock1 });
  fromMock.mockReturnValue({ update: updateMock });
});

describe('normaliseOutcome', () => {
  const cases: Array<[string, string | null]> = [
    // success family
    ['success', 'success'],
    ['SUCCESS', 'success'],
    ['Succeeded', 'success'],
    ['  ok  ', 'success'],
    ['DONE', 'success'],
    ['shipped', 'success'],
    // failed family
    ['failed', 'failed'],
    ['FAIL', 'failed'],
    ['broke', 'failed'],
    ['regression', 'failed'],
    // partial family
    ['partial', 'partial'],
    ['partial_success', 'partial'],
    ['Partial-Success', 'partial'],
    ['mixed', 'partial'],
    // unknown family
    ['unknown', 'unknown'],
    ['TBD', 'unknown'],
    ['pending', 'unknown'],
    // rejected
    ['zombie', null],
    ['', null],
    ['   ', null],
  ];

  for (const [input, expected] of cases) {
    it(`normalises ${JSON.stringify(input)} → ${expected ?? 'null'}`, () => {
      expect(normaliseOutcome(input)).toBe(expected);
    });
  }

  it('rejects non-string input', () => {
    expect(normaliseOutcome(undefined as unknown as string)).toBe(null);
    expect(normaliseOutcome(42 as unknown as string)).toBe(null);
  });
});

describe('handleUpdateOutcome — happy path', () => {
  it('updates outcome, writes audit, syncs Qdrant payload', async () => {
    getDecisionByIdMock.mockResolvedValueOnce({
      id: 'd-1',
      outcome: 'unknown',
    } as never);

    const result = await handleUpdateOutcome({
      decision_id: 'd-1',
      outcome: 'SUCCEEDED',
      reason: 'OAuth migration complete',
    });

    expect('error' in result).toBe(false);
    if ('error' in result) return; // type-narrow
    expect(result.previous_outcome).toBe('unknown');
    expect(result.outcome).toBe('success'); // normalised
    expect(result.outcome_reason).toBe('OAuth migration complete');
    expect(result.outcome_updated_at).toMatch(/T.+Z$/); // ISO timestamp

    // Postgres write
    expect(updateMock).toHaveBeenCalledWith({
      outcome: 'success',
      outcome_reason: 'OAuth migration complete',
      outcome_updated_at: expect.stringMatching(/T.+Z$/),
    });

    // Audit entry recorded with prior + new outcomes
    expect(createAuditEntryMock).toHaveBeenCalledTimes(1);

    // Qdrant payload sync to keep search-time ranker in step
    expect(setDecisionPayloadMock).toHaveBeenCalledWith(expect.any(Object), 'd-1', {
      outcome: 'success',
    });
  });

  it('coerces empty/whitespace reason to null', async () => {
    getDecisionByIdMock.mockResolvedValueOnce({
      id: 'd-2',
      outcome: null,
    } as never);

    const result = await handleUpdateOutcome({
      decision_id: 'd-2',
      outcome: 'failed',
      reason: '   ',
    });

    expect('error' in result).toBe(false);
    if ('error' in result) return;
    expect(result.outcome_reason).toBe(null);
    expect(result.previous_outcome).toBe('unknown'); // null prior → 'unknown'
  });
});

describe('handleUpdateOutcome — error paths', () => {
  it('rejects unknown outcome before any DB call', async () => {
    const result = await handleUpdateOutcome({
      decision_id: 'd-1',
      outcome: 'zombie',
    });

    expect('error' in result).toBe(true);
    if (!('error' in result)) return;
    expect(result.error).toBe('invalid_outcome');
    expect(result.allowed).toEqual(CANONICAL_OUTCOMES);

    // No DB calls were attempted
    expect(getDecisionByIdMock).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
    expect(createAuditEntryMock).not.toHaveBeenCalled();
  });

  it('returns decision_not_found when the row is missing in caller org', async () => {
    getDecisionByIdMock.mockResolvedValueOnce(null);

    const result = await handleUpdateOutcome({
      decision_id: 'd-missing',
      outcome: 'success',
    });

    expect('error' in result).toBe(true);
    if (!('error' in result)) return;
    expect(result.error).toBe('decision_not_found');
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('maps Postgres permission errors to unauthorized', async () => {
    getDecisionByIdMock.mockResolvedValueOnce({
      id: 'd-1',
      outcome: 'unknown',
    } as never);
    eqMock2.mockResolvedValueOnce({
      error: { message: 'new row violates row-level security policy' },
    });

    const result = await handleUpdateOutcome({
      decision_id: 'd-1',
      outcome: 'success',
    });

    expect('error' in result).toBe(true);
    if (!('error' in result)) return;
    expect(result.error).toBe('unauthorized');
  });

  it('Qdrant sync failure does NOT break the response', async () => {
    getDecisionByIdMock.mockResolvedValueOnce({
      id: 'd-1',
      outcome: 'unknown',
    } as never);
    setDecisionPayloadMock.mockRejectedValueOnce(new Error('Qdrant 503'));

    const result = await handleUpdateOutcome({
      decision_id: 'd-1',
      outcome: 'success',
    });

    expect('error' in result).toBe(false);
    if ('error' in result) return;
    expect(result.outcome).toBe('success');
  });
});

describe('handleUpdateOutcome — project_id scoping (issue #54)', () => {
  // Cross-org case: decision lives in a project whose owning org differs
  // from the caller's auth-resolved org_id (typical OAuth plugin path).
  // Without args.project_id the lookup filters by org_id and misses the
  // row; with args.project_id the helper switches to (id, project_id) and
  // the row is found — gated by a membership precheck so service-role
  // bypass doesn't open privilege escalation.

  it('rejects with project_access_denied when caller is not a project member', async () => {
    canWriteToProjectMock.mockResolvedValueOnce(false);

    const result = await handleUpdateOutcome({
      decision_id: 'd-cross-org',
      outcome: 'success',
      project_id: 'project-mojob',
    });

    expect('error' in result).toBe(true);
    if (!('error' in result)) return;
    expect(result.error).toBe('project_access_denied');
    // Critical: precheck blocks BEFORE any decision lookup or write.
    expect(getDecisionByIdMock).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('passes project_id to getDecisionById when membership ok', async () => {
    canWriteToProjectMock.mockResolvedValueOnce(true);
    getDecisionByIdMock.mockResolvedValueOnce({
      id: 'd-cross-org',
      outcome: 'unknown',
      project_id: 'project-mojob',
    } as never);

    const result = await handleUpdateOutcome({
      decision_id: 'd-cross-org',
      outcome: 'success',
      project_id: 'project-mojob',
    });

    expect('error' in result).toBe(false);
    // The helper is the load-bearing piece: 4th arg signals project-scoped
    // lookup. Without this the cross-org row never matches.
    expect(getDecisionByIdMock).toHaveBeenCalledWith(
      expect.any(Object),
      'test-org-id',
      'd-cross-org',
      'project-mojob',
    );
  });

  it('scopes the UPDATE WHERE by project_id (not org_id) when given', async () => {
    canWriteToProjectMock.mockResolvedValueOnce(true);
    getDecisionByIdMock.mockResolvedValueOnce({
      id: 'd-cross-org',
      outcome: 'unknown',
      project_id: 'project-mojob',
    } as never);

    await handleUpdateOutcome({
      decision_id: 'd-cross-org',
      outcome: 'success',
      project_id: 'project-mojob',
    });

    // First .eq is always (id, decision_id). Second .eq must be
    // (project_id, args.project_id) — NOT (org_id, config.org_id).
    expect(eqMock1).toHaveBeenCalledWith('id', 'd-cross-org');
    expect(eqMock2).toHaveBeenCalledWith('project_id', 'project-mojob');
    // Negative assertion — the legacy org-scoped UPDATE WHERE would have
    // silently affected zero rows for cross-org decisions.
    expect(eqMock2).not.toHaveBeenCalledWith('org_id', 'test-org-id');
  });

  it('preserves legacy org_id-scoped UPDATE when project_id is absent', async () => {
    getDecisionByIdMock.mockResolvedValueOnce({
      id: 'd-1',
      outcome: 'unknown',
    } as never);

    await handleUpdateOutcome({
      decision_id: 'd-1',
      outcome: 'success',
    });

    // No project_id → no membership check, legacy WHERE org_id applies.
    expect(canWriteToProjectMock).not.toHaveBeenCalled();
    expect(eqMock2).toHaveBeenCalledWith('org_id', 'test-org-id');
  });
});
