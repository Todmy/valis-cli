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
} = vi.hoisted(() => ({
  fromMock: vi.fn(),
  updateMock: vi.fn(),
  eqMock1: vi.fn(),
  eqMock2: vi.fn(),
  setDecisionPayloadMock: vi.fn(),
  createAuditEntryMock: vi.fn(),
  getDecisionByIdMock: vi.fn(),
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

import {
  handleUpdateOutcome,
  normaliseOutcome,
  CANONICAL_OUTCOMES,
} from '../../../src/mcp/tools/update-outcome.js';

beforeEach(() => {
  vi.clearAllMocks();
  setDecisionPayloadMock.mockResolvedValue(undefined);
  createAuditEntryMock.mockResolvedValue(undefined);
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
