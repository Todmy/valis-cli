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

import { hookUserPromptSubmitCommand } from '../../src/hooks/user-prompt-submit-handler.js';

const ORG_ID = '11111111-1111-1111-1111-111111111111';
const PROJECT_ID = '22222222-2222-2222-2222-222222222222';

let tempHome: string;
let projectDir: string;
let stdoutChunks: string[];
let writeSpy: ReturnType<typeof vi.spyOn>;
let prevValisHome: string | undefined;
let prevClaudeProjectDir: string | undefined;
let prevClaudeUserPrompt: string | undefined;
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
  prevFetch = globalThis.fetch;

  process.env.VALIS_HOME = tempHome;
  process.env.CLAUDE_PROJECT_DIR = projectDir;
  process.env.CLAUDE_USER_PROMPT = 'how do we cache decisions?';

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
  if (prevFetch) globalThis.fetch = prevFetch;
  await rm(tempHome, { recursive: true, force: true });
  await rm(projectDir, { recursive: true, force: true });
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
    expect(ctx).toMatch(/^<valis_search_results /);
    expect(ctx).toMatch(/for_prompt="[a-f0-9]+"/);
    expect(ctx).toContain('id="a"');
  });

  it('Branch B: all results below threshold → empty stdout', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse([{ id: 'a', summary: 's', type: 'decision', score: 0.1 }]),
    );
    await hookUserPromptSubmitCommand();
    expect(stdoutChunks.length).toBe(0);
  });

  it('Branch C: above threshold but over budget → empty stdout', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse([
        { id: 'big', summary: 'X'.repeat(10000), type: 'decision', score: 0.9 },
      ]),
    );
    await setProjectConfig({ per_prompt_budget: 50 });
    await hookUserPromptSubmitCommand();
    expect(stdoutChunks.length).toBe(0);
  });

  it('Branch D: project-level opt-out short-circuits before fetch', async () => {
    await setProjectConfig({ per_prompt_augmentation: false });
    await hookUserPromptSubmitCommand();
    expect(stdoutChunks.length).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('Branch D: user-level opt-out short-circuits before fetch', async () => {
    await setGlobalConfig({ per_prompt_augmentation: false });
    await hookUserPromptSubmitCommand();
    expect(stdoutChunks.length).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('Branch E: timeout → empty stdout', async () => {
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
    await setProjectConfig({}); // ensure project augmentation is on
    await setGlobalConfig({});
    // Override the project budget/threshold defaults are fine.
    process.env.CLAUDE_USER_PROMPT = 'q';
    // We can't override timeoutMs directly through env; but the mock rejects
    // synchronously fast enough that the standard 1500 ms wait is not needed:
    await hookUserPromptSubmitCommand();
    // Either timeout-branch or fetch_failed-branch: both produce empty stdout.
    expect(stdoutChunks.length).toBe(0);
  });

  it('emits no output for empty CLAUDE_USER_PROMPT', async () => {
    delete process.env.CLAUDE_USER_PROMPT;
    await hookUserPromptSubmitCommand();
    expect(stdoutChunks.length).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('Branch A on a Cyrillic prompt — no language gate', async () => {
    process.env.CLAUDE_USER_PROMPT = 'Як ми кешуємо рішення?';
    fetchMock.mockResolvedValueOnce(
      jsonResponse([
        { id: 'cy', summary: 'cache pattern', type: 'pattern', score: 0.85 },
      ]),
    );
    await hookUserPromptSubmitCommand();
    expect(stdoutChunks.length).toBe(1);
  });
});
