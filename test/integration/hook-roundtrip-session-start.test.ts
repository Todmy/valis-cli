/**
 * SessionStart hook roundtrip — Phase B (post-#172).
 *
 * The hook no longer fetches /api/projects/[id]/context or emits a
 * <valis_team_decisions> envelope. It runs only self-heal locally and
 * exits with empty stdout. The agent loads team context on demand via
 * the valis_context MCP tool, which authenticates correctly through
 * Claude Code's OAuth-aware MCP transport.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { hookSessionStartCommand } from '../../src/hooks/session-start-handler.js';

const ORG_ID = '11111111-1111-1111-1111-111111111111';
const PROJECT_ID = '22222222-2222-2222-2222-222222222222';

let tempHome: string;
let projectDir: string;
let stdoutChunks: string[];
let writeSpy: ReturnType<typeof vi.spyOn>;
let fetchSpy: ReturnType<typeof vi.spyOn> | undefined;
let prevValisHome: string | undefined;
let prevClaudeProjectDir: string | undefined;
let prevClaudeSessionId: string | undefined;

beforeEach(async () => {
  tempHome = await mkdtemp(join(tmpdir(), 'valis-int-ss-'));
  projectDir = await mkdtemp(join(tmpdir(), 'valis-proj-ss-'));

  prevValisHome = process.env.VALIS_HOME;
  prevClaudeProjectDir = process.env.CLAUDE_PROJECT_DIR;
  prevClaudeSessionId = process.env.CLAUDE_SESSION_ID;

  process.env.VALIS_HOME = tempHome;
  process.env.CLAUDE_PROJECT_DIR = projectDir;
  process.env.CLAUDE_SESSION_ID = 'sess-test-1';
  // Suppress the update-notifier registry call so it doesn't leak into
  // the BUG #119/#120 regression assertions. The notifier is exercised
  // independently in test/hooks/update-notifier.test.ts.
  process.env.VALIS_NO_UPDATE_NOTIFIER = '1';

  stdoutChunks = [];
  writeSpy = vi
    .spyOn(process.stdout, 'write')
    .mockImplementation((chunk: unknown) => {
      stdoutChunks.push(String(chunk));
      return true;
    }) as ReturnType<typeof vi.spyOn>;

  // Spy on fetch to assert post-#172 contract: no backend calls from the hook.
  fetchSpy = vi.spyOn(globalThis, 'fetch') as unknown as ReturnType<typeof vi.spyOn>;
});

afterEach(async () => {
  writeSpy.mockRestore();
  fetchSpy?.mockRestore();
  if (prevValisHome === undefined) delete process.env.VALIS_HOME;
  else process.env.VALIS_HOME = prevValisHome;
  if (prevClaudeProjectDir === undefined) delete process.env.CLAUDE_PROJECT_DIR;
  else process.env.CLAUDE_PROJECT_DIR = prevClaudeProjectDir;
  if (prevClaudeSessionId === undefined) delete process.env.CLAUDE_SESSION_ID;
  else process.env.CLAUDE_SESSION_ID = prevClaudeSessionId;
  delete process.env.VALIS_NO_UPDATE_NOTIFIER;
  await rm(tempHome, { recursive: true, force: true });
  await rm(projectDir, { recursive: true, force: true });
});

async function writeMarkerAndConfig(): Promise<void> {
  await mkdir(tempHome, { recursive: true });
  await writeFile(
    join(tempHome, 'config.json'),
    JSON.stringify({
      org_id: ORG_ID,
      member_api_key: 'tmm_test',
      api_base_url: 'http://test',
    }),
  );
  await writeFile(
    join(projectDir, '.valis.json'),
    JSON.stringify({ project_id: PROJECT_ID, project_name: 'valis' }),
  );
}

describe('SessionStart hook (post-#172) — local-only', () => {
  it('emits empty stdout when running in a Valis-configured project', async () => {
    await writeMarkerAndConfig();
    await hookSessionStartCommand();
    expect(stdoutChunks).toEqual([]);
  });

  it('emits empty stdout when not in a Valis-configured directory', async () => {
    // No .valis.json marker — hook short-circuits.
    await hookSessionStartCommand();
    expect(stdoutChunks).toEqual([]);
  });

  it('does NOT make any HTTP request (regression — closes BUG #119/#120)', async () => {
    await writeMarkerAndConfig();
    await hookSessionStartCommand();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('does NOT make any HTTP request even when project is unconfigured', async () => {
    await hookSessionStartCommand();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('completes well under the 500ms self-heal budget for a fresh project', async () => {
    await writeMarkerAndConfig();
    const t0 = Date.now();
    await hookSessionStartCommand();
    expect(Date.now() - t0).toBeLessThan(500);
  });
});
