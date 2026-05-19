/**
 * UserPromptSubmit hook roundtrip integration test (T034, US2).
 *
 * Exercises the always-inject path under simulated Claude-Code env and
 * asserts each documented branch produces the right stdout shape.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { hookUserPromptSubmitCommand } from '../../src/hooks/user-prompt-submit-handler.js';
import {
  DEFAULT_MIN_TURN,
  freshMarker,
  writeSessionMarker,
  readSessionMarker,
  type SessionMarker,
} from '../../src/hooks/session-marker.js';

const ORG_ID = '11111111-1111-1111-1111-111111111111';
const PROJECT_ID = '22222222-2222-2222-2222-222222222222';

let tempHome: string;
let projectDir: string;
let stdoutChunks: string[];
let writeSpy: ReturnType<typeof vi.spyOn>;
let prevValisHome: string | undefined;
let prevClaudeProjectDir: string | undefined;
let prevClaudeUserPrompt: string | undefined;
let prevClaudeSessionId: string | undefined;
let prevFetch: typeof globalThis.fetch | undefined;
const fetchMock = vi.fn();

async function setProjectConfig(overrides: Record<string, unknown> = {}): Promise<void> {
  await writeFile(
    join(projectDir, '.valis.json'),
    JSON.stringify({ project_id: PROJECT_ID, project_name: 'valis', ...overrides }),
  );
}

async function setGlobalConfig(overrides: Record<string, unknown> = {}): Promise<void> {
  await writeFile(
    join(tempHome, 'config.json'),
    JSON.stringify({
      org_id: ORG_ID,
      member_api_key: 'tmm_test',
      api_base_url: 'http://test',
      ...overrides,
    }),
  );
}

beforeEach(async () => {
  tempHome = await mkdtemp(join(tmpdir(), 'valis-int-up-'));
  projectDir = await mkdtemp(join(tmpdir(), 'valis-proj-up-'));

  prevValisHome = process.env.VALIS_HOME;
  prevClaudeProjectDir = process.env.CLAUDE_PROJECT_DIR;
  prevClaudeUserPrompt = process.env.CLAUDE_USER_PROMPT;
  prevClaudeSessionId = process.env.CLAUDE_SESSION_ID;
  prevFetch = globalThis.fetch;

  process.env.VALIS_HOME = tempHome;
  process.env.CLAUDE_PROJECT_DIR = projectDir;
  process.env.CLAUDE_USER_PROMPT = 'how do we cache decisions and patterns?';
  process.env.VALIS_DISABLE_PRUNE = '1';
  // Disable capture-reminder by default for the existing Branch A-E tests.
  // Dedicated tests below set CLAUDE_SESSION_ID + project_config to exercise it.
  delete process.env.CLAUDE_SESSION_ID;

  await mkdir(tempHome, { recursive: true });
  await setGlobalConfig();
  await setProjectConfig();

  fetchMock.mockReset();
  globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

  stdoutChunks = [];
  writeSpy = vi
    .spyOn(process.stdout, 'write')
    .mockImplementation((chunk: unknown) => {
      stdoutChunks.push(String(chunk));
      return true;
    }) as ReturnType<typeof vi.spyOn>;
});

afterEach(async () => {
  writeSpy.mockRestore();
  if (prevValisHome === undefined) delete process.env.VALIS_HOME;
  else process.env.VALIS_HOME = prevValisHome;
  if (prevClaudeProjectDir === undefined) delete process.env.CLAUDE_PROJECT_DIR;
  else process.env.CLAUDE_PROJECT_DIR = prevClaudeProjectDir;
  if (prevClaudeUserPrompt === undefined) delete process.env.CLAUDE_USER_PROMPT;
  else process.env.CLAUDE_USER_PROMPT = prevClaudeUserPrompt;
  if (prevClaudeSessionId === undefined) delete process.env.CLAUDE_SESSION_ID;
  else process.env.CLAUDE_SESSION_ID = prevClaudeSessionId;
  if (prevFetch) globalThis.fetch = prevFetch;
  // BUG #177 — APFS race: pending hook handler writes (`writeSessionMarker`,
  // telemetry appends) sometimes finish *after* the test body returns, so a
  // straight `rm(..., force)` hits ENOTEMPTY on rmdir. Mirror the e05270f
  // self-heal fix: retry up to 5× with 50ms backoff. Node 14.14+.
  await rm(tempHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  await rm(projectDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

function jsonResponse(results: unknown[]): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({ results }),
  } as Response;
}

describe('UserPromptSubmit roundtrip', () => {
  it('Branch A: served result emits <valis_search_results> with for_prompt hash', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse([
        { id: 'a', summary: 'cache TTL pattern', type: 'decision', score: 0.9 },
      ]),
    );
    await hookUserPromptSubmitCommand();
    expect(stdoutChunks.length).toBe(1);
    const parsed = JSON.parse(stdoutChunks[0]);
    expect(parsed.hookSpecificOutput.hookEventName).toBe('UserPromptSubmit');
    const ctx = parsed.hookSpecificOutput.additionalContext as string;
    // BUG #176: active-project block is always first, search results follow.
    expect(ctx).toMatch(/^<valis_active_project /);
    expect(ctx).toContain('<valis_search_results ');
    expect(ctx).toMatch(/for_prompt="[a-f0-9]+"/);
    expect(ctx).toContain('id="a"');
  });

  it('Branch B: all results below threshold → only active-project block emitted (BUG #176)', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse([{ id: 'a', summary: 's', type: 'decision', score: 0.1 }]),
    );
    await hookUserPromptSubmitCommand();
    expect(stdoutChunks.length).toBe(1);
    const ctx = JSON.parse(stdoutChunks[0]).hookSpecificOutput.additionalContext as string;
    expect(ctx).toMatch(/^<valis_active_project /);
    expect(ctx).not.toContain('<valis_search_results ');
  });

  it('Branch C: above threshold but over budget → only active-project block emitted (BUG #176)', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse([
        { id: 'big', summary: 'X'.repeat(10000), type: 'decision', score: 0.9 },
      ]),
    );
    await setProjectConfig({ per_prompt_budget: 50 });
    await hookUserPromptSubmitCommand();
    expect(stdoutChunks.length).toBe(1);
    const ctx = JSON.parse(stdoutChunks[0]).hookSpecificOutput.additionalContext as string;
    expect(ctx).toMatch(/^<valis_active_project /);
    expect(ctx).not.toContain('<valis_search_results ');
  });

  it('Branch D: project-level opt-out skips search but still emits active-project (BUG #176)', async () => {
    await setProjectConfig({ per_prompt_augmentation: false });
    await hookUserPromptSubmitCommand();
    expect(stdoutChunks.length).toBe(1);
    const ctx = JSON.parse(stdoutChunks[0]).hookSpecificOutput.additionalContext as string;
    expect(ctx).toMatch(/^<valis_active_project /);
    expect(ctx).not.toContain('<valis_search_results ');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('Branch D: user-level opt-out skips search but still emits active-project (BUG #176)', async () => {
    await setGlobalConfig({ per_prompt_augmentation: false });
    await hookUserPromptSubmitCommand();
    expect(stdoutChunks.length).toBe(1);
    const ctx = JSON.parse(stdoutChunks[0]).hookSpecificOutput.additionalContext as string;
    expect(ctx).toMatch(/^<valis_active_project /);
    expect(ctx).not.toContain('<valis_search_results ');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('Branch E: timeout → only active-project block emitted (BUG #176)', async () => {
    fetchMock.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          setTimeout(() => {
            const err = new Error('aborted');
            (err as { name: string }).name = 'AbortError';
            reject(err);
          }, 5);
        }),
    );
    await setProjectConfig({});
    await setGlobalConfig({});
    process.env.CLAUDE_USER_PROMPT = 'q';
    await hookUserPromptSubmitCommand();
    // Even on timeout/fetch_failed, the active-project block lands so the
    // agent still knows the scope when calling valis_* MCP tools.
    expect(stdoutChunks.length).toBe(1);
    const ctx = JSON.parse(stdoutChunks[0]).hookSpecificOutput.additionalContext as string;
    expect(ctx).toMatch(/^<valis_active_project /);
    expect(ctx).not.toContain('<valis_search_results ');
  });

  it('emits no output for empty CLAUDE_USER_PROMPT', async () => {
    delete process.env.CLAUDE_USER_PROMPT;
    await hookUserPromptSubmitCommand();
    expect(stdoutChunks.length).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('BUG #177: reads prompt + session_id from stdin envelope when env vars are missing', async () => {
    // Reproduce real Claude Code behaviour: prompt arrives ONLY via the
    // stdin JSON envelope; CLAUDE_USER_PROMPT / CLAUDE_SESSION_ID are not
    // set. Before the fix, the handler silent-no-op'd → zero search,
    // zero <valis_active_project>, zero telemetry across every real session.
    delete process.env.CLAUDE_USER_PROMPT;
    delete process.env.CLAUDE_SESSION_ID;

    const envelopeJson = JSON.stringify({
      transcript_path: '/tmp/none',
      hook_event_name: 'UserPromptSubmit',
      prompt: 'how do we handle envelope-only prompts',
      session_id: 'bug177-envelope-only',
    });
    const realStdin = process.stdin;
    const fakeStdin = Readable.from([envelopeJson]) as unknown as NodeJS.ReadStream;
    Object.defineProperty(process, 'stdin', { value: fakeStdin, configurable: true });
    // Mark not-TTY so readHookEnvelope proceeds to drain the stream.
    Object.defineProperty(fakeStdin, 'isTTY', { value: false, configurable: true });

    fetchMock.mockResolvedValueOnce(
      jsonResponse([
        { id: 'env1', summary: 'envelope path', type: 'decision', score: 0.9 },
      ]),
    );
    try {
      await hookUserPromptSubmitCommand();
    } finally {
      Object.defineProperty(process, 'stdin', { value: realStdin, configurable: true });
    }

    // Active-project block must always be emitted now that the prompt is reachable.
    expect(stdoutChunks.length).toBeGreaterThan(0);
    const out = stdoutChunks.join('');
    expect(out).toContain('<valis_active_project');
    // Backend search must have been attempted with the envelope's prompt.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toMatchObject({
      query: 'how do we handle envelope-only prompts',
    });
  });

  it('Branch A on a Cyrillic prompt — no language gate', async () => {
    process.env.CLAUDE_USER_PROMPT = 'Як ми кешуємо рішення в системі?';
    fetchMock.mockResolvedValueOnce(
      jsonResponse([
        { id: 'cy', summary: 'cache pattern', type: 'pattern', score: 0.85 },
      ]),
    );
    await hookUserPromptSubmitCommand();
    expect(stdoutChunks.length).toBe(1);
  });
});

describe('UserPromptSubmit roundtrip — capture-reminder injection', () => {
  const SESSION_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const CLOCK = new Date('2026-05-12T10:00:00.000Z');

  beforeEach(async () => {
    process.env.CLAUDE_SESSION_ID = SESSION_ID;
    fetchMock.mockResolvedValue(jsonResponse([])); // no search results by default
  });

  it('does not inject reminder before the turn threshold (only active-project block — BUG #176)', async () => {
    await writeSessionMarker(freshMarker(SESSION_ID, CLOCK));
    await hookUserPromptSubmitCommand();
    // Active-project always lands; capture-reminder doesn't fire below threshold.
    expect(stdoutChunks.length).toBe(1);
    const ctx = JSON.parse(stdoutChunks[0]).hookSpecificOutput.additionalContext as string;
    expect(ctx).toMatch(/^<valis_active_project /);
    expect(ctx).not.toContain('<channel source="valis"');
    const after = await readSessionMarker(SESSION_ID);
    expect(after?.turn_count).toBe(1);
    expect(after?.reminder_count).toBe(0);
  });

  it('injects reminder block when turn count reaches threshold', async () => {
    const preSeed: SessionMarker = {
      ...freshMarker(SESSION_ID, CLOCK),
      turn_count: DEFAULT_MIN_TURN - 1,
    };
    await writeSessionMarker(preSeed);

    await hookUserPromptSubmitCommand();
    expect(stdoutChunks.length).toBe(1);
    const parsed = JSON.parse(stdoutChunks[0]);
    const ctx = parsed.hookSpecificOutput.additionalContext as string;
    expect(ctx).toMatch(/<channel source="valis" event="capture_reminder"/);
    expect(ctx).toContain('valis_store');

    const after = await readSessionMarker(SESSION_ID);
    expect(after?.reminder_count).toBe(1);
    expect(after?.last_reminder_turn).toBe(DEFAULT_MIN_TURN);
  });

  it('composes search results BEFORE the capture reminder', async () => {
    const preSeed: SessionMarker = {
      ...freshMarker(SESSION_ID, CLOCK),
      turn_count: DEFAULT_MIN_TURN - 1,
    };
    await writeSessionMarker(preSeed);

    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(
      jsonResponse([
        { id: 'r1', summary: 'relevant decision', type: 'decision', score: 0.9 },
      ]),
    );

    await hookUserPromptSubmitCommand();
    expect(stdoutChunks.length).toBe(1);
    const ctx = JSON.parse(stdoutChunks[0]).hookSpecificOutput.additionalContext as string;
    const searchIdx = ctx.indexOf('<valis_search_results');
    const reminderIdx = ctx.indexOf('<channel source="valis"');
    expect(searchIdx).toBeGreaterThanOrEqual(0);
    expect(reminderIdx).toBeGreaterThanOrEqual(0);
    expect(searchIdx).toBeLessThan(reminderIdx);
  });

  it('suppresses reminder when project config disables it (active-project block still emitted)', async () => {
    await setProjectConfig({ capture_reminder_enabled: false });
    const preSeed: SessionMarker = {
      ...freshMarker(SESSION_ID, CLOCK),
      turn_count: DEFAULT_MIN_TURN + 5,
    };
    await writeSessionMarker(preSeed);

    await hookUserPromptSubmitCommand();
    // BUG #176: active-project block remains; only the capture reminder is suppressed.
    expect(stdoutChunks.length).toBe(1);
    const ctx = JSON.parse(stdoutChunks[0]).hookSpecificOutput.additionalContext as string;
    expect(ctx).toMatch(/^<valis_active_project /);
    expect(ctx).not.toContain('<channel source="valis"');
    const after = await readSessionMarker(SESSION_ID);
    expect(after?.reminder_count).toBe(0);
  });

  it('skips reminder when CLAUDE_SESSION_ID is missing (active-project block still emitted)', async () => {
    delete process.env.CLAUDE_SESSION_ID;
    await hookUserPromptSubmitCommand();
    // BUG #176: active-project block doesn't depend on session_id — it
    // comes purely from the project marker.
    expect(stdoutChunks.length).toBe(1);
    const ctx = JSON.parse(stdoutChunks[0]).hookSpecificOutput.additionalContext as string;
    expect(ctx).toMatch(/^<valis_active_project /);
    expect(ctx).not.toContain('<channel source="valis"');
  });

  it('does not count slash-command prompts as turns', async () => {
    process.env.CLAUDE_USER_PROMPT = '/help me with this please right now';
    await writeSessionMarker(freshMarker(SESSION_ID, CLOCK));
    await hookUserPromptSubmitCommand();
    const after = await readSessionMarker(SESSION_ID);
    expect(after?.turn_count).toBe(0);
  });

  it('reminder fires alone when augment returns empty (no search block)', async () => {
    const preSeed: SessionMarker = {
      ...freshMarker(SESSION_ID, CLOCK),
      turn_count: DEFAULT_MIN_TURN - 1,
    };
    await writeSessionMarker(preSeed);

    await hookUserPromptSubmitCommand();
    expect(stdoutChunks.length).toBe(1);
    const ctx = JSON.parse(stdoutChunks[0]).hookSpecificOutput.additionalContext as string;
    expect(ctx).not.toContain('<valis_search_results');
    expect(ctx).toContain('<channel source="valis" event="capture_reminder"');
  });
});
