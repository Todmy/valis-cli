/**
 * 019/US2 (T009 + T070 + T071 + T096 + T097) — valis_check_diff MCP tool tests.
 *
 * Mocks the global fetch per audit-client.test pattern; covers the 6 cases
 * from research R-007 plus the two analyze-patch cases (T070 zero-decisions
 * cost guard, T071 shared-budget assertion) plus the four post-/speckit.analyze
 * retrofits: T096 covers the three FR-007 failure categories that T009 missed
 * (oversized 413, malformed 400, project-not-accessible 403); T097 promotes
 * FR-010's "nothing to check" short-circuit from prompt-only logic to a
 * code-asserted invariant on the wrapper.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { handleCheckDiff } from '../../../src/mcp/tools/check-diff.js';
import type { ServerConfig } from '../../../src/types.js';

// Mock loadConfig so the tool can run with a synthetic CLI config when
// `configOverride` is not provided.
vi.mock('../../../src/config/store.js', () => ({
  loadConfig: vi.fn(),
}));

// Mock resolveConfig to avoid filesystem .valis.json lookups.
vi.mock('../../../src/config/project.js', () => ({
  resolveConfig: vi.fn().mockResolvedValue({ global: null, project: null }),
}));

const SAMPLE_DIFF =
  'diff --git a/src/auth/jwt.ts b/src/auth/jwt.ts\n' +
  '@@ -42,5 +42,4 @@\n' +
  ' verify(token);\n' +
  '-checkNonce(token);\n' +
  ' return decoded;\n';

function buildServerConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    org_id: 'test-org',
    member_id: 'test-member',
    author_name: 'tester',
    role: 'member',
    auth_mode: 'jwt',
    supabase_url: 'https://test.supabase.co',
    supabase_service_role_key: 'srk-test',
    qdrant_url: 'https://test.qdrant.io',
    qdrant_api_key: 'qkey-test',
    api_key: 'tmm_test',
    member_api_key: 'tmm_test',
    project_id: '00000000-0000-0000-0000-000000000001',
    ...overrides,
  } as ServerConfig;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('handleCheckDiff', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  // R-007 test 1
  it('successful response with violations — returns summary + per-violation blocks + footer', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        violations: [
          {
            decision_id: 'd1',
            severity: 'block',
            file_path: 'src/auth/jwt.ts',
            line_start: 42,
            line_end: 58,
            decision_summary: 'Always use JWT replay protection',
            rationale: 'Your patch removes the nonce check from the verify path.',
          },
          {
            decision_id: 'd2',
            severity: 'warn',
            file_path: 'src/auth/jwt.ts',
            line_start: 90,
            line_end: 95,
            decision_summary: 'Log auth failures',
          },
        ],
        budget_exhausted: false,
        decisions_evaluated: 7,
        decisions_skipped: 0,
        elapsed_ms: 12345,
      }),
    );

    const result = await handleCheckDiff({ diff: SAMPLE_DIFF }, buildServerConfig());

    expect(result.isError).toBeUndefined();
    expect(result.content.length).toBeGreaterThanOrEqual(3); // summary + 2 violations + footer
    expect(result.content[0].text).toContain('Found 2 decision violations');
    expect(result.content[0].text).toContain('1 block');
    expect(result.content[0].text).toContain('Decisions evaluated: 7');
    expect(result.content[1].text).toContain('src/auth/jwt.ts:42-58');
    expect(result.content[1].text).toContain('block');
    expect(result.content[1].text).toContain('Always use JWT replay protection');
    // Footer present because there is at least one block-severity violation
    expect(result.content[result.content.length - 1].text).toContain('valis-ack');
  });

  // R-007 test 2
  it('empty violations array — returns friendly success message', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        violations: [],
        budget_exhausted: false,
        decisions_evaluated: 7,
        decisions_skipped: 0,
        elapsed_ms: 1500,
      }),
    );

    const result = await handleCheckDiff({ diff: SAMPLE_DIFF }, buildServerConfig());

    expect(result.isError).toBeUndefined();
    expect(result.content).toHaveLength(1);
    expect(result.content[0].text).toContain('Working tree is clean');
    expect(result.content[0].text).toContain('Decisions evaluated: 7');
  });

  // R-007 test 3
  it('401 unauthorized — surfaces error code', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(401, { error: 'unauthorized', message: 'Missing or malformed Authorization header.' }),
    );

    const result = await handleCheckDiff({ diff: SAMPLE_DIFF }, buildServerConfig());

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('unauthorized');
  });

  // R-007 test 4
  it('429 rate_limit_exceeded — soft fail-open via 200+reason path or hard error via 4xx', async () => {
    // /api/check returns 429 + structured error for hard cap. The tool surfaces
    // the error code without inventing a soft fail-open.
    fetchMock.mockResolvedValueOnce(
      jsonResponse(429, {
        error: 'rate_limit_exceeded',
        message: 'Free-tier daily check cap reached. Try again tomorrow or upgrade your plan.',
      }),
    );

    const result = await handleCheckDiff({ diff: SAMPLE_DIFF }, buildServerConfig());

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('rate_limit_exceeded');
  });

  // R-007 test 5 — soft fail-open
  it('200 with soft-fail-open reason — surfaces reason without isError', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        violations: [],
        budget_exhausted: true,
        decisions_evaluated: 0,
        decisions_skipped: 0,
        elapsed_ms: 5,
        reason: 'qdrant_unavailable',
      }),
    );

    const result = await handleCheckDiff({ diff: SAMPLE_DIFF }, buildServerConfig());

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('Check skipped');
    expect(result.content[0].text).toContain('decision retrieval is temporarily unavailable');
  });

  // R-007 test 6
  it('network error — fetch throws, surfaces network_unreachable error', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const result = await handleCheckDiff({ diff: SAMPLE_DIFF }, buildServerConfig());

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('network_unreachable');
    expect(result.content[0].text).toContain('ECONNREFUSED');
  });

  // T070 — analyze C3 patch: SC-007 zero-decisions cost gap.
  it('no captured decisions — returns success message with friendly hint, no upstream call avoided beyond /api/check', async () => {
    // /api/check signals "no decisions yet" with decisions_evaluated=0 and no soft reason.
    // The tool must surface a friendly hint without isError.
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        violations: [],
        budget_exhausted: false,
        decisions_evaluated: 0,
        decisions_skipped: 0,
        elapsed_ms: 8,
      }),
    );

    const result = await handleCheckDiff({ diff: SAMPLE_DIFF }, buildServerConfig());

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('no recorded decisions yet');
    // The tool issues exactly one upstream call to /api/check — matching PR-time path
    // means it does NOT short-circuit on its own (the server decides). Asserting the
    // single call protects against future regressions that try to "optimize" by
    // skipping the call.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // T071 — analyze C6 patch: FR-008 shared-budget assertion.
  it('shares budget counter with PR-time checks — back-to-back in-session calls each hit /api/check', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(200, {
          violations: [],
          budget_exhausted: false,
          decisions_evaluated: 5,
          decisions_skipped: 0,
          elapsed_ms: 100,
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          violations: [],
          budget_exhausted: false,
          decisions_evaluated: 5,
          decisions_skipped: 0,
          elapsed_ms: 100,
        }),
      );

    const config = buildServerConfig();
    await handleCheckDiff({ diff: SAMPLE_DIFF }, config);
    await handleCheckDiff({ diff: SAMPLE_DIFF }, config);

    // Each in-session check posts to /api/check exactly once, so 2 calls total.
    // The /api/check route's debit_check_budget RPC is what enforces a SHARED
    // counter with PR-time checks (no separate quota path exists in the tool).
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [, init] of fetchMock.mock.calls) {
      expect((init as RequestInit).method).toBe('POST');
      const body = JSON.parse((init as RequestInit).body as string);
      // pr_url MUST NOT be sent — that's what makes the audit row
      // surface = 'in_session' on the server side (per R-005).
      expect(body.metadata?.pr_url).toBeUndefined();
      expect(body).toHaveProperty('project_id');
      expect(body).toHaveProperty('diff');
    }
  });

  // Request-shape assertion (R-007): pr_url is never forwarded even when caller
  // passes metadata.actor — protects the in_session classification at the route.
  it('omits pr_url from request body even when actor metadata is provided', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        violations: [],
        budget_exhausted: false,
        decisions_evaluated: 1,
        decisions_skipped: 0,
        elapsed_ms: 50,
      }),
    );

    await handleCheckDiff(
      {
        diff: SAMPLE_DIFF,
        metadata: { actor: 'alice in IDE', commit_sha: 'abc1234' },
      },
      buildServerConfig(),
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.metadata.actor).toBe('alice in IDE');
    expect(body.metadata.commit_sha).toBe('abc1234');
    expect(body.metadata.pr_url).toBeUndefined();
  });

  // Edge case: no project scope at all.
  it('rejects when no project_id is resolvable from args, override, or .valis.json', async () => {
    const config = buildServerConfig({ project_id: undefined });
    const result = await handleCheckDiff({ diff: SAMPLE_DIFF }, config);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('project_not_found');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // T097 — analyze C5 patch: FR-010 "nothing to check" promoted from
  // prompt-only logic into the wrapper. Empty / whitespace-only diff returns
  // the friendly success message with isError ABSENT and ZERO fetch calls
  // (zero backend cost per FR-010). Two fixtures: '' and a multi-whitespace
  // string. Both must short-circuit identically.
  it.each([
    ['empty string', ''],
    ['whitespace only', '   \n  \t\n'],
  ])('FR-010 — %s diff returns success with zero fetch calls', async (_label, diff) => {
    const result = await handleCheckDiff({ diff }, buildServerConfig());
    expect(result.isError).toBeUndefined();
    expect(result.content).toHaveLength(1);
    expect(result.content[0].text).toContain('Working tree is clean');
    expect(result.content[0].text).toContain('nothing to check');
    // Hardest-edge guarantee: NO network calls. Protects FR-010's
    // "zero backend cost" promise against future regressions.
    expect(fetchMock).toHaveBeenCalledTimes(0);
  });

  // T096 — analyze H5 patch: FR-007 explicit failure categories. T009's
  // original 6 cases covered 401/429/500/network — these three add the
  // remaining categories named in FR-007 (oversized, malformed, not-accessible).

  it('FR-007 oversized diff (413) — surfaces "diff_too_large" with the limit', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(413, {
        error: 'diff_too_large',
        message: 'Diff exceeds size limit.',
        max_bytes: 524288,
      }),
    );
    const result = await handleCheckDiff({ diff: SAMPLE_DIFF }, buildServerConfig());
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('diff_too_large');
    expect(result.content[0].text).toContain('Split the change');
    // The limit must be surfaced so the user knows what to aim for.
    expect(result.content[0].text).toMatch(/524,?288/);
  });

  it('FR-007 malformed diff (400) — surfaces "invalid_diff" with parse hint', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(400, {
        error: 'invalid_diff',
        message: 'Could not parse unified diff at line 7.',
      }),
    );
    const result = await handleCheckDiff({ diff: SAMPLE_DIFF }, buildServerConfig());
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('invalid_diff');
    expect(result.content[0].text).toContain('could not be parsed');
    expect(result.content[0].text).toContain('git diff');
  });

  it('FR-007 project not accessible (403) — does not leak project_id to the agent', async () => {
    const secretProjectId = '99999999-aaaa-bbbb-cccc-dddddddddddd';
    fetchMock.mockResolvedValueOnce(
      jsonResponse(403, {
        error: 'project_not_accessible',
        message: `Member is not a participant in project ${secretProjectId}.`,
      }),
    );
    const result = await handleCheckDiff({ diff: SAMPLE_DIFF }, buildServerConfig());
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('project_not_accessible');
    expect(result.content[0].text).toContain('do not have access');
    // Critical: the upstream message contains the project UUID; our wrapper
    // must NOT echo it through to the agent (information leak guard).
    expect(result.content[0].text).not.toContain(secretProjectId);
  });
});
