/**
 * Tests for the v0.5.3 PreCompact handler — default silent no-op +
 * opt-in gate behavior under `VALIS_PRECOMPACT_GATE=1`.
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
let prevGateFlag: string | undefined;

beforeEach(async () => {
  tempHome = await mkdtemp(join(tmpdir(), 'valis-precompact-'));
  projectDir = await mkdtemp(join(tmpdir(), 'valis-proj-precompact-'));

  prevValisHome = process.env.VALIS_HOME;
  prevClaudeProjectDir = process.env.CLAUDE_PROJECT_DIR;
  prevClaudeSessionId = process.env.CLAUDE_SESSION_ID;
  prevGateFlag = process.env.VALIS_PRECOMPACT_GATE;

  process.env.VALIS_HOME = tempHome;
  process.env.CLAUDE_PROJECT_DIR = projectDir;
  delete process.env.VALIS_PRECOMPACT_GATE;

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
  if (prevGateFlag === undefined) delete process.env.VALIS_PRECOMPACT_GATE;
  else process.env.VALIS_PRECOMPACT_GATE = prevGateFlag;
  await rm(tempHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  await rm(projectDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

describe('hookPreCompactCommand — default (gate disabled)', () => {
  it('emits empty stdout — /compact passes through with no error toast', async () => {
    process.env.CLAUDE_SESSION_ID = 'sess-default-1';
    await hookPreCompactCommand();
    expect(stdoutChunks.join('')).toBe('');
  });

  it('does not check sentinel state when gate is off', async () => {
    process.env.CLAUDE_SESSION_ID = 'sess-default-2';
    // Pre-create a sentinel — under default behavior it shouldn't be consumed.
    await createSentinel({
      session_id: 'sess-default-2',
      created_at: new Date().toISOString(),
      stored_count: 1,
    });
    await hookPreCompactCommand();
    expect(stdoutChunks.join('')).toBe('');
    // Sentinel stays untouched (we don't consume in disabled mode).
    expect(await hasSentinel('sess-default-2')).toBe(true);
  });

  it('does not emit a block when VALIS_PRECOMPACT_GATE is unset', async () => {
    process.env.CLAUDE_SESSION_ID = 'sess-default-3';
    await hookPreCompactCommand();
    const out = stdoutChunks.join('');
    expect(out).not.toContain('"decision":"block"');
    expect(out).not.toContain('Pre-compaction capture required');
  });
});

describe('hookPreCompactCommand — gate enabled (VALIS_PRECOMPACT_GATE=1)', () => {
  beforeEach(() => {
    process.env.VALIS_PRECOMPACT_GATE = '1';
  });

  it('blocks with structured reason when sentinel absent', async () => {
    process.env.CLAUDE_SESSION_ID = 'sess-gated-block';
    await hookPreCompactCommand();
    const payload = JSON.parse(stdoutChunks.join(''));
    expect(payload.decision).toBe('block');
    expect(payload.reason).toContain('valis hook capture-done');
    expect(payload.reason).toContain('/compact');
  });

  it('allows when fresh sentinel exists and consumes it', async () => {
    process.env.CLAUDE_SESSION_ID = 'sess-gated-allow';
    await createSentinel({
      session_id: 'sess-gated-allow',
      created_at: new Date().toISOString(),
      stored_count: 2,
    });
    await hookPreCompactCommand();
    expect(stdoutChunks.join('')).toBe('');
    expect(await hasSentinel('sess-gated-allow')).toBe(false);
  });

  it('accepts truthy aliases for the gate env var', async () => {
    process.env.CLAUDE_SESSION_ID = 'sess-gated-alias';
    for (const value of ['true', 'yes', '1']) {
      process.env.VALIS_PRECOMPACT_GATE = value;
      stdoutChunks.length = 0;
      await hookPreCompactCommand();
      const out = stdoutChunks.join('');
      expect(out).toContain('"decision":"block"');
    }
  });
});
