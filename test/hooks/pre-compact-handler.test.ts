/**
 * Integration tests for the v0.5.2 PreCompact hook handler — sentinel-
 * gated block-and-allow flow.
 *
 * The handler reads from stdin (envelope) and stdout (decision JSON),
 * so we use the same spy pattern as hook-roundtrip-session-start.test.ts.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { hookPreCompactCommand } from '../../src/hooks/pre-compact-handler.js';
import { createSentinel, hasSentinel } from '../../src/hooks/sentinels.js';

const ORG_ID = '11111111-1111-1111-1111-111111111111';
const PROJECT_ID = '22222222-2222-2222-2222-222222222222';

let tempHome: string;
let projectDir: string;
let stdoutChunks: string[];
let writeSpy: ReturnType<typeof vi.spyOn>;
let prevValisHome: string | undefined;
let prevClaudeProjectDir: string | undefined;
let prevClaudeSessionId: string | undefined;

beforeEach(async () => {
  tempHome = await mkdtemp(join(tmpdir(), 'valis-precompact-'));
  projectDir = await mkdtemp(join(tmpdir(), 'valis-proj-precompact-'));

  prevValisHome = process.env.VALIS_HOME;
  prevClaudeProjectDir = process.env.CLAUDE_PROJECT_DIR;
  prevClaudeSessionId = process.env.CLAUDE_SESSION_ID;

  process.env.VALIS_HOME = tempHome;
  process.env.CLAUDE_PROJECT_DIR = projectDir;

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
  if (prevClaudeSessionId === undefined) delete process.env.CLAUDE_SESSION_ID;
  else process.env.CLAUDE_SESSION_ID = prevClaudeSessionId;
  // Telemetry record() runs fire-and-forget appendFile; retry on rmdir
  // race like e05270f / BUG #177 did for session-start.
  await rm(tempHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  await rm(projectDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

describe('hookPreCompactCommand — sentinel absent (block path)', () => {
  it('emits decision=block when no sentinel exists for this session', async () => {
    process.env.CLAUDE_SESSION_ID = 'sess-needs-capture';

    await hookPreCompactCommand();

    expect(stdoutChunks.length).toBeGreaterThan(0);
    const payload = JSON.parse(stdoutChunks.join(''));
    expect(payload.decision).toBe('block');
    expect(typeof payload.reason).toBe('string');
  });

  it('block reason includes the exact Bash invocation for capture-done', async () => {
    process.env.CLAUDE_SESSION_ID = 'sess-needs-bash';
    await hookPreCompactCommand();
    const payload = JSON.parse(stdoutChunks.join(''));
    expect(payload.reason).toContain('valis hook capture-done');
    expect(payload.reason).toContain('--stored');
  });

  it('block reason instructs to invoke /compact via SlashCommand', async () => {
    process.env.CLAUDE_SESSION_ID = 'sess-needs-slashcommand';
    await hookPreCompactCommand();
    const payload = JSON.parse(stdoutChunks.join(''));
    expect(payload.reason).toContain('SlashCommand');
    expect(payload.reason).toContain('/compact');
  });

  it('block reason walks the agent through extraction steps (valis_store imperative)', async () => {
    process.env.CLAUDE_SESSION_ID = 'sess-needs-store';
    await hookPreCompactCommand();
    const payload = JSON.parse(stdoutChunks.join(''));
    expect(payload.reason).toContain('valis_store');
    expect(payload.reason).toMatch(/decision.*constraint.*pattern.*lesson/);
  });

  it('block reason carries the session_id when known', async () => {
    process.env.CLAUDE_SESSION_ID = 'sess-with-id-in-reason';
    await hookPreCompactCommand();
    const payload = JSON.parse(stdoutChunks.join(''));
    expect(payload.reason).toContain('sess-with-id-in-reason');
  });

  it('blocks with a session-id-less reason when CLAUDE_SESSION_ID is missing', async () => {
    delete process.env.CLAUDE_SESSION_ID;
    await hookPreCompactCommand();
    const payload = JSON.parse(stdoutChunks.join(''));
    expect(payload.decision).toBe('block');
    expect(payload.reason).toContain('CLAUDE_SESSION_ID');
  });
});

describe('hookPreCompactCommand — sentinel present (allow path)', () => {
  it('emits empty stdout when a fresh sentinel exists', async () => {
    process.env.CLAUDE_SESSION_ID = 'sess-allowed';
    await createSentinel({
      session_id: 'sess-allowed',
      created_at: new Date().toISOString(),
      stored_count: 3,
    });

    await hookPreCompactCommand();

    expect(stdoutChunks.join('')).toBe('');
  });

  it('consumes the sentinel after a successful allow so the next /compact re-blocks', async () => {
    process.env.CLAUDE_SESSION_ID = 'sess-consumes';
    await createSentinel({
      session_id: 'sess-consumes',
      created_at: new Date().toISOString(),
      stored_count: 1,
    });
    expect(await hasSentinel('sess-consumes')).toBe(true);

    await hookPreCompactCommand();

    // Sentinel cleanup is fire-and-forget; allow a microtask tick.
    await new Promise((r) => setImmediate(r));
    expect(await hasSentinel('sess-consumes')).toBe(false);
  });

  it('still blocks when the sentinel belongs to a different session_id', async () => {
    process.env.CLAUDE_SESSION_ID = 'session-A';
    await createSentinel({
      session_id: 'session-B',
      created_at: new Date().toISOString(),
      stored_count: 1,
    });

    await hookPreCompactCommand();

    const payload = JSON.parse(stdoutChunks.join(''));
    expect(payload.decision).toBe('block');
  });
});
