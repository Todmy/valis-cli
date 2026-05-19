/**
 * Unit tests for capture-done-handler.ts — `valis hook capture-done`
 * CLI command (v0.5.2 block-and-gate flow).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { hookCaptureDoneCommand } from '../../src/hooks/capture-done-handler.js';
import { hasSentinel, readSentinel } from '../../src/hooks/sentinels.js';

let tmpHome: string;
let originalValisHome: string | undefined;
let originalSessionId: string | undefined;

beforeEach(async () => {
  tmpHome = await mkdtemp(join(tmpdir(), 'valis-capture-done-'));
  originalValisHome = process.env.VALIS_HOME;
  process.env.VALIS_HOME = tmpHome;
  originalSessionId = process.env.CLAUDE_SESSION_ID;
});

afterEach(async () => {
  if (originalValisHome === undefined) {
    delete process.env.VALIS_HOME;
  } else {
    process.env.VALIS_HOME = originalValisHome;
  }
  if (originalSessionId === undefined) {
    delete process.env.CLAUDE_SESSION_ID;
  } else {
    process.env.CLAUDE_SESSION_ID = originalSessionId;
  }
  await rm(tmpHome, { recursive: true, force: true });
});

describe('hookCaptureDoneCommand', () => {
  it('uses CLAUDE_SESSION_ID from env when no explicit session_id passed', async () => {
    process.env.CLAUDE_SESSION_ID = 'env-session-1';
    const result = await hookCaptureDoneCommand({});
    expect(result).toBe('env-session-1');
    expect(await hasSentinel('env-session-1')).toBe(true);
  });

  it('prefers explicit sessionId over env', async () => {
    process.env.CLAUDE_SESSION_ID = 'env-session';
    const result = await hookCaptureDoneCommand({ sessionId: 'override-session' });
    expect(result).toBe('override-session');
    expect(await hasSentinel('override-session')).toBe(true);
    expect(await hasSentinel('env-session')).toBe(false);
  });

  it('returns null and writes to stderr when no session_id available', async () => {
    delete process.env.CLAUDE_SESSION_ID;
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const result = await hookCaptureDoneCommand({});
    expect(result).toBeNull();
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('no session_id'));
    stderrSpy.mockRestore();
  });

  it('persists stored count and note in the sentinel', async () => {
    process.env.CLAUDE_SESSION_ID = 'sess-with-meta';
    await hookCaptureDoneCommand({ stored: 5, note: 'phase 13 decisions' });
    const sentinel = await readSentinel('sess-with-meta');
    expect(sentinel?.stored_count).toBe(5);
    expect(sentinel?.note).toBe('phase 13 decisions');
  });

  it('defaults stored_count to 0 when not provided', async () => {
    process.env.CLAUDE_SESSION_ID = 'sess-empty';
    await hookCaptureDoneCommand({});
    const sentinel = await readSentinel('sess-empty');
    expect(sentinel?.stored_count).toBe(0);
  });

  it('emits instruction to invoke /compact via SlashCommand on stdout', async () => {
    process.env.CLAUDE_SESSION_ID = 'sess-stdout';
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await hookCaptureDoneCommand({ stored: 2 });
    expect(stdoutSpy).toHaveBeenCalledWith(
      expect.stringContaining('SlashCommand tool'),
    );
    expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining('/compact'));
    stdoutSpy.mockRestore();
  });
});
