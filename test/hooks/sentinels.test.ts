/**
 * Unit tests for sentinels.ts — capture-done sentinel store for the
 * pre-compact block-and-gate flow (v0.5.2).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  SENTINEL_TTL_MS,
  clearSentinel,
  createSentinel,
  hasSentinel,
  pruneOldSentinels,
  readSentinel,
} from '../../src/hooks/sentinels.js';
import { captureSentinelDir, captureSentinelPath } from '../../src/hooks/paths.js';

let tmpHome: string;
let originalValisHome: string | undefined;

beforeEach(async () => {
  tmpHome = await mkdtemp(join(tmpdir(), 'valis-sentinels-'));
  originalValisHome = process.env.VALIS_HOME;
  process.env.VALIS_HOME = tmpHome;
});

afterEach(async () => {
  if (originalValisHome === undefined) {
    delete process.env.VALIS_HOME;
  } else {
    process.env.VALIS_HOME = originalValisHome;
  }
  await rm(tmpHome, { recursive: true, force: true });
});

describe('createSentinel', () => {
  it('writes a valid JSON payload atomically', async () => {
    const ok = await createSentinel({
      session_id: 'sess-1',
      created_at: new Date().toISOString(),
      stored_count: 3,
    });
    expect(ok).toBe(true);

    const raw = await readFile(captureSentinelPath('sess-1'), 'utf-8');
    const parsed = JSON.parse(raw);
    expect(parsed.session_id).toBe('sess-1');
    expect(parsed.stored_count).toBe(3);
  });

  it('overwrites an existing sentinel (multiple /compact cycles in one session)', async () => {
    await createSentinel({
      session_id: 'sess-2',
      created_at: '2026-01-01T00:00:00Z',
      stored_count: 1,
    });
    await createSentinel({
      session_id: 'sess-2',
      created_at: '2026-01-01T00:01:00Z',
      stored_count: 5,
    });
    const second = await readSentinel('sess-2');
    expect(second?.stored_count).toBe(5);
  });

  it('leaves no .tmp residue on success', async () => {
    await createSentinel({
      session_id: 'sess-3',
      created_at: new Date().toISOString(),
      stored_count: 0,
    });
    await expect(
      stat(`${captureSentinelPath('sess-3')}.tmp`),
    ).rejects.toThrow();
  });

  it('returns false on IO failure (e.g. VALIS_HOME points at a read-only path)', async () => {
    // Point VALIS_HOME at a file (not a directory) — mkdir will fail.
    const fakeHome = join(tmpHome, 'not-a-dir');
    await writeFile(fakeHome, 'i am a file', 'utf-8');
    process.env.VALIS_HOME = fakeHome;

    const ok = await createSentinel({
      session_id: 'sess-fail',
      created_at: new Date().toISOString(),
      stored_count: 0,
    });
    expect(ok).toBe(false);
  });
});

describe('hasSentinel', () => {
  it('returns false when the sentinel does not exist', async () => {
    expect(await hasSentinel('never-existed')).toBe(false);
  });

  it('returns true for a freshly-created sentinel', async () => {
    await createSentinel({
      session_id: 'sess-fresh',
      created_at: new Date().toISOString(),
      stored_count: 2,
    });
    expect(await hasSentinel('sess-fresh')).toBe(true);
  });

  it('returns false for a sentinel past SENTINEL_TTL_MS', async () => {
    await createSentinel({
      session_id: 'sess-old',
      created_at: new Date(Date.now() - SENTINEL_TTL_MS * 2).toISOString(),
      stored_count: 1,
    });
    // Backdate the file's mtime past the TTL.
    const path = captureSentinelPath('sess-old');
    const oldTime = (Date.now() - SENTINEL_TTL_MS * 2) / 1000;
    await utimes(path, oldTime, oldTime);

    expect(await hasSentinel('sess-old')).toBe(false);
  });

  it('returns false on read errors (treat absent — block side is safe)', async () => {
    // Point VALIS_HOME at a non-existent path; stat will throw.
    process.env.VALIS_HOME = join(tmpHome, 'nonexistent');
    expect(await hasSentinel('whatever')).toBe(false);
  });
});

describe('readSentinel', () => {
  it('returns the parsed payload', async () => {
    const payload = {
      session_id: 'sess-read',
      created_at: '2026-05-19T12:00:00Z',
      stored_count: 7,
      note: 'happy path',
    };
    await createSentinel(payload);
    const got = await readSentinel('sess-read');
    expect(got).toEqual(payload);
  });

  it('returns null when the file is missing', async () => {
    expect(await readSentinel('never-was')).toBeNull();
  });

  it('returns null when the file has invalid JSON', async () => {
    const path = captureSentinelPath('corrupted');
    await writeFile(path, '{not valid json', 'utf-8').catch(async () => {
      // If parent dir is missing, create it first.
      const { mkdir } = await import('node:fs/promises');
      await mkdir(captureSentinelDir(), { recursive: true });
      await writeFile(path, '{not valid json', 'utf-8');
    });
    expect(await readSentinel('corrupted')).toBeNull();
  });

  it('returns null when payload is missing required fields', async () => {
    const { mkdir } = await import('node:fs/promises');
    await mkdir(captureSentinelDir(), { recursive: true });
    const path = captureSentinelPath('partial');
    await writeFile(path, JSON.stringify({ session_id: 'partial' }), 'utf-8');
    expect(await readSentinel('partial')).toBeNull();
  });
});

describe('clearSentinel', () => {
  it('removes an existing sentinel', async () => {
    await createSentinel({
      session_id: 'sess-clear',
      created_at: new Date().toISOString(),
      stored_count: 0,
    });
    expect(await hasSentinel('sess-clear')).toBe(true);

    const ok = await clearSentinel('sess-clear');
    expect(ok).toBe(true);
    expect(await hasSentinel('sess-clear')).toBe(false);
  });

  it('is idempotent on a missing sentinel (returns true via force)', async () => {
    const ok = await clearSentinel('never-existed');
    expect(ok).toBe(true);
  });
});

describe('pruneOldSentinels', () => {
  it('returns 0 when the sentinel directory is missing', async () => {
    process.env.VALIS_HOME = join(tmpHome, 'empty');
    const removed = await pruneOldSentinels();
    expect(removed).toBe(0);
  });

  it('removes only sentinels older than SENTINEL_TTL_MS', async () => {
    // Two fresh + one stale.
    await createSentinel({
      session_id: 'fresh-1',
      created_at: new Date().toISOString(),
      stored_count: 1,
    });
    await createSentinel({
      session_id: 'fresh-2',
      created_at: new Date().toISOString(),
      stored_count: 1,
    });
    await createSentinel({
      session_id: 'stale-1',
      created_at: new Date().toISOString(),
      stored_count: 1,
    });
    const stalePath = captureSentinelPath('stale-1');
    const oldTime = (Date.now() - SENTINEL_TTL_MS * 2) / 1000;
    await utimes(stalePath, oldTime, oldTime);

    const removed = await pruneOldSentinels();
    expect(removed).toBe(1);
    expect(await hasSentinel('fresh-1')).toBe(true);
    expect(await hasSentinel('fresh-2')).toBe(true);
    expect(await hasSentinel('stale-1')).toBe(false);
  });

  it('skips non-JSON files in the sentinel directory', async () => {
    await createSentinel({
      session_id: 'real',
      created_at: new Date().toISOString(),
      stored_count: 1,
    });
    // Drop a stray file the prune loop must not touch.
    const { mkdir } = await import('node:fs/promises');
    await mkdir(captureSentinelDir(), { recursive: true });
    const strayPath = join(captureSentinelDir(), 'README.txt');
    await writeFile(strayPath, 'not a sentinel', 'utf-8');
    const oldTime = (Date.now() - SENTINEL_TTL_MS * 2) / 1000;
    await utimes(strayPath, oldTime, oldTime);

    const removed = await pruneOldSentinels();
    expect(removed).toBe(0);
    await expect(stat(strayPath)).resolves.toBeDefined();
  });
});
