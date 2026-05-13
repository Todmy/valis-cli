/**
 * 024 US1 — `valis init --template <name>` non-interactive seeding.
 *
 * Test scope: this file covers the new code surface added by 024 at the
 * unit level. The full-stack integration (commander → dispatcher → fetch →
 * .valis.json) is exercised indirectly via:
 *   - `chooseTemplate` (the only NEW deep module) — flag resolution, picker
 *     gating, unknown-name fail-fast.
 *   - `createProject` (extended with `templateId` + 402/500 parsing) —
 *     request body shape + server-error surfacing.
 *
 * 019/US6's `template/validate.test.ts` covers the registry; `templates.md`
 * server contract is covered by `packages/web/test/api/projects-create.*`.
 * Together these three test files plus the quickstart smoke fully cover
 * the spec acceptance scenarios without spawning a CLI subprocess per case.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  chooseTemplate,
  ChooseTemplateError,
  type ChooseTemplateOptions,
} from '../../src/commands/init/template-choice.js';
import { createProject } from '../../src/cloud/supabase/members.js';

// ---------------------------------------------------------------------------
// chooseTemplate — flag resolution + picker gating
// ---------------------------------------------------------------------------

function withFlag(overrides: Partial<ChooseTemplateOptions> = {}): ChooseTemplateOptions {
  return {
    flagValue: 'ts-saas',
    orgPlan: 'free',
    nonInteractive: true,
    newProjectFlow: true,
    ...overrides,
  };
}

describe('chooseTemplate — flag path (US1)', () => {
  it('returns the validated TemplateId when --template matches a registry key', async () => {
    const result = await chooseTemplate(withFlag({ flagValue: 'ts-saas' }));
    expect(result).toBe('ts-saas');
  });

  it('accepts the other two registry keys symmetrically', async () => {
    expect(await chooseTemplate(withFlag({ flagValue: 'fintech' }))).toBe('fintech');
    expect(await chooseTemplate(withFlag({ flagValue: 'ai-agent' }))).toBe('ai-agent');
  });

  it('throws ChooseTemplateError with exit code 2 on an unknown --template value (US1.4)', async () => {
    // The error MUST fire before any network call. Fail-fast is the contract.
    await expect(chooseTemplate(withFlag({ flagValue: 'not-real' }))).rejects.toMatchObject({
      kind: 'unknown_template',
      exitCode: 2,
    });
    await expect(chooseTemplate(withFlag({ flagValue: 'not-real' }))).rejects.toThrow(
      /Unknown template 'not-real'\. Available: ts-saas, fintech, ai-agent\./,
    );
  });

  it('throws flag_in_wrong_flow when newProjectFlow=false (defense in depth)', async () => {
    await expect(
      chooseTemplate(withFlag({ flagValue: 'ts-saas', newProjectFlow: false })),
    ).rejects.toBeInstanceOf(ChooseTemplateError);
  });
});

describe('chooseTemplate — non-interactive default path (FR-008)', () => {
  it('returns null and prints a tip when --template is absent and stdin is not a TTY', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const result = await chooseTemplate({
      flagValue: undefined,
      orgPlan: 'free',
      nonInteractive: true,
      newProjectFlow: true,
    });
    expect(result).toBeNull();
    expect(logSpy.mock.calls.some(([msg]) => /pass `--template ts-saas`/.test(String(msg)))).toBe(
      true,
    );
    logSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// createProject — templateId pass-through + error surface
// ---------------------------------------------------------------------------

function makeFetchMock(response: { status: number; body: unknown }): typeof fetch {
  return vi.fn(async () =>
    ({
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      json: async () => response.body,
    }) as Response,
  ) as unknown as typeof fetch;
}

describe('createProject — template_id pass-through (US1)', () => {
  const SUPABASE_URL = 'https://valis.krukit.co';
  const API_KEY = 'tmm_abc123';
  const ORG_ID = '11111111-1111-1111-1111-111111111111';
  const PROJECT_NAME = 'my-saas';

  let fetchSpy: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
  });

  it('US1.1 happy path — sends template_id in body and parses decisions_seeded from 200', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        project_id: 'proj-xyz',
        project_name: PROJECT_NAME,
        invite_code: 'INVT-CODE',
        template_source: 'ts-saas@v0.1',
        decisions_seeded: 18,
      }),
    } as Response);

    const result = await createProject(SUPABASE_URL, API_KEY, ORG_ID, PROJECT_NAME, undefined, 'ts-saas');

    expect(result.project_id).toBe('proj-xyz');
    expect(result.template_source).toBe('ts-saas@v0.1');
    expect(result.decisions_seeded).toBe(18);

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({
      org_id: ORG_ID,
      project_name: PROJECT_NAME,
      template_id: 'ts-saas',
    });
  });

  it('US1.2 plan_too_low — surfaces 402 message and upsell_url in the thrown error', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: false,
      status: 402,
      json: async () => ({
        error: 'plan_too_low',
        message: "The 'fintech' template requires the 'pro' plan or higher.",
        upsell_url: '/billing/upgrade',
      }),
    } as Response);

    await expect(
      createProject(SUPABASE_URL, API_KEY, ORG_ID, PROJECT_NAME, undefined, 'fintech'),
    ).rejects.toThrow(/requires the 'pro' plan or higher\. See \/billing\/upgrade/);
  });

  it('US1.3 seed_failed — adds retry hint to the 500 error message', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => ({ error: 'seed_failed' }),
    } as Response);

    await expect(
      createProject(SUPABASE_URL, API_KEY, ORG_ID, PROJECT_NAME, undefined, 'ts-saas'),
    ).rejects.toThrow(/Please retry the same command/);
  });

  it('omits template_id from request body when templateId is undefined (preserves blank flow)', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        project_id: 'proj-blank',
        project_name: PROJECT_NAME,
        invite_code: 'INVT-CODE',
      }),
    } as Response);

    await createProject(SUPABASE_URL, API_KEY, ORG_ID, PROJECT_NAME);

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body).not.toHaveProperty('template_id');
  });

  it('FR-011 community-mode rejection — throws "Templates require hosted mode" when EF unavailable + templateId set', async () => {
    // Simulate Edge Function totally unavailable (network unreachable). The
    // SQL fallback path MUST refuse to seed a template via direct INSERT.
    fetchSpy.mockRejectedValueOnce(new Error('fetch failed'));

    await expect(
      // No serviceRoleKey provided here on purpose — the community fallback
      // can't proceed AND template is set, so we expect the explicit refusal
      // before any direct-SQL attempt.
      createProject(SUPABASE_URL, API_KEY, ORG_ID, PROJECT_NAME, undefined, 'ts-saas'),
    ).rejects.toThrow(/Templates require hosted mode/);
  });
});

// ---------------------------------------------------------------------------
// US3 — `--join` + `--template` mutual exclusion (guardrail)
// ---------------------------------------------------------------------------

describe('initCommand dispatcher — flag conflict guard (US3)', () => {
  it('the guard exists at the top of the dispatcher (defense-in-depth contract)', async () => {
    // The actual `process.exit(2)` cannot be smoke-tested without spawning a
    // subprocess. Instead this test pins the contract from spec US3.1: the
    // exact error message used by the dispatcher MUST stay in sync. If
    // initCommand drifts, the message string check below fails — caller
    // expectations elsewhere (CI, docs) lock the wording.
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const dispatcherSource = readFileSync(
      join(__dirname, '..', '..', 'src', 'commands', 'init.ts'),
      'utf-8',
    );
    expect(dispatcherSource).toContain(
      'Cannot combine --join and --template. Templates only apply to newly created projects.',
    );
    // And it MUST exit non-zero — verifying the literal exit code in the source.
    expect(dispatcherSource).toMatch(/options\.join && options\.template[\s\S]*?process\.exit\(2\)/);
  });

  it('the .valis.json refuse guard exists for US1.5', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const dispatcherSource = readFileSync(
      join(__dirname, '..', '..', 'src', 'commands', 'init.ts'),
      'utf-8',
    );
    expect(dispatcherSource).toContain(
      'A project is already configured here. Use `valis switch` to change projects, or remove .valis.json first.',
    );
  });

  it('the not-logged-in refuse guard exists for FR-011', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const dispatcherSource = readFileSync(
      join(__dirname, '..', '..', 'src', 'commands', 'init.ts'),
      'utf-8',
    );
    expect(dispatcherSource).toContain('Templates require an existing Valis account');
  });
});

// ---------------------------------------------------------------------------
// Unused helper kept inline for symmetry; ensures the mock-builder signature
// matches future tests that may use it.
// ---------------------------------------------------------------------------

describe('makeFetchMock smoke', () => {
  it('builds a Response-compatible mock from a status + body pair', async () => {
    const mock = makeFetchMock({ status: 200, body: { ok: true } });
    const res = await mock('https://example' as unknown as RequestInfo);
    expect(res.ok).toBe(true);
    expect(await res.json()).toEqual({ ok: true });
  });
});
