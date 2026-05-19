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
let prevAutoUpdate: string | undefined;
let prevNoNotifier: string | undefined;
let stderrWrites: string[];
let stderrSpy: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  tempHome = await mkdtemp(join(tmpdir(), 'valis-notifier-'));
  prevValisHome = process.env.VALIS_HOME;
  prevAutoUpdate = process.env.VALIS_AUTO_UPDATE;
  prevNoNotifier = process.env.VALIS_NO_UPDATE_NOTIFIER;
  process.env.VALIS_HOME = tempHome;
  // Default: opt OUT of auto-install for these tests so they exercise
  // the notice branch deterministically across dev/CI machines (some
  // have npm under a version manager, some don't). Specific tests
  // override this when they want to exercise the auto-install branch.
  process.env.VALIS_AUTO_UPDATE = '0';
  delete process.env.VALIS_NO_UPDATE_NOTIFIER;
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
  if (prevAutoUpdate === undefined) delete process.env.VALIS_AUTO_UPDATE;
  else process.env.VALIS_AUTO_UPDATE = prevAutoUpdate;
  if (prevNoNotifier === undefined) delete process.env.VALIS_NO_UPDATE_NOTIFIER;
  else process.env.VALIS_NO_UPDATE_NOTIFIER = prevNoNotifier;
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

describe('readPreferences — config + env opt-outs', () => {
  it('defaults to { notifier on, auto_install on } with no config and no env', async () => {
    delete process.env.VALIS_AUTO_UPDATE;
    const prefs = await __test__.readPreferences();
    expect(prefs.notifier_enabled).toBe(true);
    expect(prefs.auto_install_enabled).toBe(true);
  });

  it('VALIS_NO_UPDATE_NOTIFIER=1 disables both notifier and auto-install (legacy kill switch)', async () => {
    delete process.env.VALIS_AUTO_UPDATE;
    process.env.VALIS_NO_UPDATE_NOTIFIER = '1';
    const prefs = await __test__.readPreferences();
    expect(prefs.notifier_enabled).toBe(false);
    expect(prefs.auto_install_enabled).toBe(false);
  });

  it('VALIS_AUTO_UPDATE=0 disables ONLY auto-install — notice still allowed', async () => {
    process.env.VALIS_AUTO_UPDATE = '0';
    const prefs = await __test__.readPreferences();
    expect(prefs.notifier_enabled).toBe(true);
    expect(prefs.auto_install_enabled).toBe(false);
  });

  it('config `auto_update: false` disables auto-install (notice still allowed)', async () => {
    delete process.env.VALIS_AUTO_UPDATE;
    await writeFile(
      join(tempHome, 'config.json'),
      JSON.stringify({ org_id: 'x', auto_update: false }),
    );
    const prefs = await __test__.readPreferences();
    expect(prefs.notifier_enabled).toBe(true);
    expect(prefs.auto_install_enabled).toBe(false);
  });

  it('config `auto_update: true` is honored as default', async () => {
    delete process.env.VALIS_AUTO_UPDATE;
    await writeFile(
      join(tempHome, 'config.json'),
      JSON.stringify({ org_id: 'x', auto_update: true }),
    );
    const prefs = await __test__.readPreferences();
    expect(prefs.auto_install_enabled).toBe(true);
  });

  it('treats config `auto_update: "false"` (string) as a non-bool and falls back to default', async () => {
    delete process.env.VALIS_AUTO_UPDATE;
    await writeFile(
      join(tempHome, 'config.json'),
      JSON.stringify({ org_id: 'x', auto_update: 'false' }),
    );
    const prefs = await __test__.readPreferences();
    // We only honor `true`/`false` literals; string "false" is ignored and
    // the default applies. This is intentional — JSON typo protection.
    expect(prefs.auto_install_enabled).toBe(true);
  });
});

describe('resolveSafeNpmGlobalRoot — version manager detection', () => {
  // We can't easily mock `npm root -g` without DI surgery, but we can
  // assert the function returns null OR a real path (no throw) on the
  // current dev machine. Behavioral contract: never blocks the host
  // hook longer than the 2s internal timeout, never throws.
  it('resolves to null or a string within 2.5s, never throws', async () => {
    const t0 = Date.now();
    const result = await __test__.resolveSafeNpmGlobalRoot();
    expect(Date.now() - t0).toBeLessThan(2500);
    expect(result === null || typeof result === 'string').toBe(true);
  });
});

describe('maybeNotifyOfUpdate — auto-install opt-outs', () => {
  it('returns "noop" when VALIS_NO_UPDATE_NOTIFIER=1, even if a newer version is cached', async () => {
    process.env.VALIS_NO_UPDATE_NOTIFIER = '1';
    await mkdir(join(tempHome, 'cache'), { recursive: true });
    await writeFile(
      join(tempHome, 'cache', 'update-check.json'),
      JSON.stringify({
        checked_at: new Date().toISOString(),
        latest_version: '99.0.0',
      }),
    );
    const action = await maybeNotifyOfUpdate('0.5.2');
    expect(action).toBe('noop');
    expect(stderrWrites.join('')).toBe('');
  });

  it('emits a notice when VALIS_AUTO_UPDATE=0 but newer version is available', async () => {
    process.env.VALIS_AUTO_UPDATE = '0';
    await mkdir(join(tempHome, 'cache'), { recursive: true });
    await writeFile(
      join(tempHome, 'cache', 'update-check.json'),
      JSON.stringify({
        checked_at: new Date().toISOString(),
        latest_version: '0.6.0',
      }),
    );
    const action = await maybeNotifyOfUpdate('0.5.2');
    expect(action).toBe('notice_emitted');
    expect(stderrWrites.join('')).toContain('0.6.0 available');
  });

  it('returns "noop" when current version equals cached latest, regardless of auto-update setting', async () => {
    delete process.env.VALIS_AUTO_UPDATE;
    await mkdir(join(tempHome, 'cache'), { recursive: true });
    await writeFile(
      join(tempHome, 'cache', 'update-check.json'),
      JSON.stringify({
        checked_at: new Date().toISOString(),
        latest_version: '0.5.2',
      }),
    );
    const action = await maybeNotifyOfUpdate('0.5.2');
    expect(action).toBe('noop');
  });
});
