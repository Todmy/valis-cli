/**
 * Update notifier — npm-registry-aware version check for valis-cli.
 *
 * Industry-standard pattern (modeled after the `update-notifier` package
 * used by npm, yarn, Claude Code, and most Node CLIs): once per 24 hours,
 * fetch the latest published version from the npm registry, cache it
 * locally, and emit a one-line notice on subsequent invocations when the
 * installed version is older than the cached "latest".
 *
 * Design:
 *
 *   - Check is **best-effort and non-blocking**: it must never throw,
 *     never delay the host hook by more than a few milliseconds on the
 *     hot path, and never fail in a way that surfaces to the user as an
 *     error (Constitution III).
 *
 *   - Notice is emitted via `process.stderr.write` — Claude Code surfaces
 *     hook stderr in its UI without treating it as a failure. The notice
 *     is two lines: the version delta + the install command. No boxen
 *     drawing, no animation.
 *
 *   - Auto-install is **deliberately not implemented**. Many users run
 *     valis-cli via volta / asdf / homebrew / corepack where global
 *     install paths are managed externally; `npm i -g valis-cli@latest`
 *     from inside our process would break those setups. The notice
 *     prints the install command so the user runs it themselves under
 *     their own version manager. Opt-in auto-install can be added later
 *     (e.g., `VALIS_AUTO_UPDATE=1` env var) if dogfooding shows the
 *     notice-only path is too passive.
 *
 *   - Cache lives at `~/.valis/cache/update-check.json` with a 24-hour
 *     TTL. Refresh runs in the background via `void` — the function
 *     returns immediately and the cache file updates whenever the
 *     registry responds.
 *
 *   - On the very first run (no cache yet), we kick off the background
 *     refresh and emit no notice. The user sees the notice on the next
 *     session-start fired ≥24h later, once we have a cached "latest" to
 *     compare against. This is consistent with how `npm update-notifier`
 *     behaves — silence on first run, notice from second run onward.
 */

import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { valisHome } from './paths.js';
import { join } from 'node:path';

const NPM_REGISTRY_URL = 'https://registry.npmjs.org/valis-cli/latest';
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 3000;

interface UpdateCacheRecord {
  /** ISO timestamp of last successful registry check. */
  checked_at: string;
  /** Latest version observed on the registry. */
  latest_version: string;
}

function cachePath(): string {
  return join(valisHome(), 'cache', 'update-check.json');
}

/**
 * Compare two semver-shaped version strings.
 * Returns positive when `a > b`, negative when `a < b`, zero when equal.
 * Tolerant of pre-release / build suffixes — only compares the dotted
 * numeric prefix (so `0.5.3-rc.1` and `0.5.3` compare equal here, which
 * is acceptable because we never want to nag about pre-releases).
 */
function compareVersions(a: string, b: string): number {
  const numericPrefix = (v: string): number[] => {
    const stripped = v.split(/[-+]/, 1)[0]!;
    return stripped.split('.').map((part) => parseInt(part, 10) || 0);
  };
  const aa = numericPrefix(a);
  const bb = numericPrefix(b);
  const len = Math.max(aa.length, bb.length);
  for (let i = 0; i < len; i++) {
    const av = aa[i] ?? 0;
    const bv = bb[i] ?? 0;
    if (av !== bv) return av - bv;
  }
  return 0;
}

async function readCache(): Promise<UpdateCacheRecord | null> {
  try {
    const raw = await readFile(cachePath(), 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      typeof (parsed as UpdateCacheRecord).checked_at !== 'string' ||
      typeof (parsed as UpdateCacheRecord).latest_version !== 'string'
    ) {
      return null;
    }
    return parsed as UpdateCacheRecord;
  } catch {
    return null;
  }
}

async function writeCache(record: UpdateCacheRecord): Promise<void> {
  try {
    const target = cachePath();
    await mkdir(dirname(target), { recursive: true });
    const tmp = `${target}.tmp`;
    await writeFile(tmp, JSON.stringify(record, null, 2), 'utf-8');
    await rename(tmp, target);
  } catch {
    // Cache write failure is non-fatal; next session-start retries.
  }
}

/**
 * Hit the npm registry, parse the `version` field, persist to cache.
 * Hard timeout via AbortController so we never block longer than
 * `FETCH_TIMEOUT_MS` (registry usually responds in 100-500ms).
 *
 * Errors swallowed — Constitution III guarantees we never throw from
 * the notifier into the host hook.
 */
async function refreshCache(): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(NPM_REGISTRY_URL, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return;
    const body = (await res.json()) as { version?: string };
    if (typeof body.version !== 'string' || !body.version) return;
    await writeCache({
      checked_at: new Date().toISOString(),
      latest_version: body.version,
    });
  } catch {
    // Network failure, parse failure, abort — all swallowed.
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Whether the cache is older than `CHECK_INTERVAL_MS`. Missing cache
 * file also returns true (so first-run kicks off the initial fetch).
 */
function cacheStale(record: UpdateCacheRecord | null): boolean {
  if (!record) return true;
  const ts = Date.parse(record.checked_at);
  if (!Number.isFinite(ts)) return true;
  return Date.now() - ts > CHECK_INTERVAL_MS;
}

/**
 * Emit a one-line notice to stderr when `currentVersion` is older than
 * `latestVersion`. Uses plain text (no ANSI colors) so logs grep cleanly.
 */
function emitNotice(currentVersion: string, latestVersion: string): void {
  try {
    process.stderr.write(
      `valis-cli ${latestVersion} available (you have ${currentVersion}). ` +
        `Run: npm i -g valis-cli@latest\n`,
    );
  } catch {
    // stderr pipe closed — silent.
  }
}

/**
 * Main entry point. Non-blocking, safe to fire-and-forget from any hook.
 *
 *   1. Read cache.
 *   2. If we have a cached "latest" and it's newer than the running
 *      version, emit the notice immediately. This is the hot path —
 *      runs synchronously off the cache file (~1ms).
 *   3. If the cache is stale (or missing), kick off a background
 *      `refreshCache()` via `void`. It writes the new cache; the next
 *      session-start uses it.
 *
 * The decoupling means the user sees the notice immediately when the
 * cache says one's available, while registry chatter happens out of the
 * critical path.
 */
export async function maybeNotifyOfUpdate(currentVersion: string): Promise<void> {
  let cached: UpdateCacheRecord | null = null;
  try {
    cached = await readCache();
  } catch {
    cached = null;
  }

  // Hot path: emit notice based on existing cache.
  if (cached && compareVersions(cached.latest_version, currentVersion) > 0) {
    emitNotice(currentVersion, cached.latest_version);
  }

  // Cold path: refresh cache if stale, in the background. The host
  // hook will return long before this resolves.
  if (cacheStale(cached)) {
    void refreshCache();
  }
}

// Exported for tests so we can deterministically exercise the
// version-compare without spinning up filesystem fixtures.
export const __test__ = { compareVersions, cacheStale };
