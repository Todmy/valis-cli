/**
 * Tests for update-notifier — npm-registry-aware version check.
 *
 * Two-layer coverage:
 *   - Pure helpers (`compareVersions`, `cacheStale`) — deterministic,
 *     no IO, no network.
 *   - Cache read/write + emit-notice path with a stubbed fetch.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  maybeNotifyOfUpdate,
  __test__,
} from '../../src/hooks/update-notifier.js';

let tempHome: string;
let prevValisHome: string | undefined;
let stderrWrites: string[];
let stderrSpy: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  tempHome = await mkdtemp(join(tmpdir(), 'valis-notifier-'));
  prevValisHome = process.env.VALIS_HOME;
  process.env.VALIS_HOME = tempHome;
  stderrWrites = [];
  stderrSpy = vi
    .spyOn(process.stderr, 'write')
    .mockImplementation((chunk: unknown) => {
      stderrWrites.push(String(chunk));
      return true;
    }) as ReturnType<typeof vi.spyOn>;
});

afterEach(async () => {
  stderrSpy.mockRestore();
  if (prevValisHome === undefined) delete process.env.VALIS_HOME;
  else process.env.VALIS_HOME = prevValisHome;
  await rm(tempHome, { recursive: true, force: true });
});

describe('compareVersions', () => {
  it('returns 0 for equal versions', () => {
    expect(__test__.compareVersions('0.5.2', '0.5.2')).toBe(0);
  });

  it('returns positive when a > b (patch)', () => {
    expect(__test__.compareVersions('0.5.3', '0.5.2')).toBeGreaterThan(0);
  });

  it('returns positive when a > b (minor)', () => {
    expect(__test__.compareVersions('0.6.0', '0.5.99')).toBeGreaterThan(0);
  });

  it('returns positive when a > b (major)', () => {
    expect(__test__.compareVersions('1.0.0', '0.999.999')).toBeGreaterThan(0);
  });

  it('returns negative when a < b', () => {
    expect(__test__.compareVersions('0.5.2', '0.5.3')).toBeLessThan(0);
  });

  it('strips pre-release / build suffixes — 0.5.3-rc.1 compares equal to 0.5.3', () => {
    expect(__test__.compareVersions('0.5.3-rc.1', '0.5.3')).toBe(0);
    expect(__test__.compareVersions('0.5.3', '0.5.3+sha.abc')).toBe(0);
  });

  it('handles trailing-zero asymmetry — 0.5 vs 0.5.0', () => {
    expect(__test__.compareVersions('0.5', '0.5.0')).toBe(0);
  });

  it('tolerates non-numeric junk by coercing to 0', () => {
    expect(__test__.compareVersions('foo.bar.baz', '0.0.0')).toBe(0);
  });
});

describe('cacheStale', () => {
  it('returns true for null (missing cache)', () => {
    expect(__test__.cacheStale(null)).toBe(true);
  });

  it('returns true for a cache older than 24h', () => {
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    expect(__test__.cacheStale({ checked_at: old, latest_version: '0.0.0' })).toBe(true);
  });

  it('returns false for a fresh cache (~minutes old)', () => {
    const recent = new Date(Date.now() - 60 * 1000).toISOString();
    expect(__test__.cacheStale({ checked_at: recent, latest_version: '0.0.0' })).toBe(false);
  });

  it('returns true when the timestamp is unparseable', () => {
    expect(__test__.cacheStale({ checked_at: 'not-an-iso', latest_version: '0.0.0' })).toBe(true);
  });
});

describe('maybeNotifyOfUpdate — cache hot path', () => {
  it('emits a stderr notice when cached latest > current', async () => {
    await mkdir(join(tempHome, 'cache'), { recursive: true });
    await writeFile(
      join(tempHome, 'cache', 'update-check.json'),
      JSON.stringify({
        checked_at: new Date().toISOString(),
        latest_version: '0.6.0',
      }),
    );
    await maybeNotifyOfUpdate('0.5.2');
    const all = stderrWrites.join('');
    expect(all).toContain('valis-cli 0.6.0 available');
    expect(all).toContain('you have 0.5.2');
    expect(all).toContain('npm i -g valis-cli@latest');
  });

  it('emits no notice when cached latest == current', async () => {
    await mkdir(join(tempHome, 'cache'), { recursive: true });
    await writeFile(
      join(tempHome, 'cache', 'update-check.json'),
      JSON.stringify({
        checked_at: new Date().toISOString(),
        latest_version: '0.5.2',
      }),
    );
    await maybeNotifyOfUpdate('0.5.2');
    expect(stderrWrites.join('')).toBe('');
  });

  it('emits no notice when cached latest < current (downgrade case)', async () => {
    await mkdir(join(tempHome, 'cache'), { recursive: true });
    await writeFile(
      join(tempHome, 'cache', 'update-check.json'),
      JSON.stringify({
        checked_at: new Date().toISOString(),
        latest_version: '0.5.0',
      }),
    );
    await maybeNotifyOfUpdate('0.5.2');
    expect(stderrWrites.join('')).toBe('');
  });

  it('emits no notice when cache is missing (first run is silent)', async () => {
    await maybeNotifyOfUpdate('0.5.2');
    expect(stderrWrites.join('')).toBe('');
  });

  it('does not throw when cache file is corrupted', async () => {
    await mkdir(join(tempHome, 'cache'), { recursive: true });
    await writeFile(join(tempHome, 'cache', 'update-check.json'), '{not valid json');
    await expect(maybeNotifyOfUpdate('0.5.2')).resolves.not.toThrow();
    expect(stderrWrites.join('')).toBe('');
  });
});
