/**
 * Update notifier + auto-installer for valis-cli.
 *
 * v0.5.4 (BUG #176 sibling — surfaced same dogfood session): the prior
 * notice-only design was passive, and Claude Code's session-start hook
 * stderr is not reliably surfaced in the UI — engineers running v0.5.3
 * could not see the "new version available" line at all. The fix is
 * (a) make the install automatic by default, (b) confine the legacy
 * notice path to the cases where auto-install would break user setups
 * (volta / asdf / nvm / brew etc.), (c) communicate via a mechanism the
 * user definitely sees on the next prompt.
 *
 * Design — three branches:
 *
 *   1. **Auto-install branch (default).** Cache says newer version
 *      exists, user has not opted out, and `npm root -g` resolves to a
 *      vanilla npm-global directory (not under a known version
 *      manager). Spawn `npm i -g valis-cli@latest` detached + unref'd,
 *      stdio routed to `~/.valis/cache/update-install.log`. Drop a
 *      sentinel at `~/.valis/cache/update-pending.json` so the
 *      UserPromptSubmit hook can announce the upgrade to the agent on
 *      the next turn (the user definitely sees additionalContext; they
 *      don't necessarily see hook stderr).
 *
 *   2. **Notice branch.** Auto-install is unsafe (version manager
 *      detected) OR explicit opt-out. Same one-line stderr notice as
 *      before, kept for back-compat and for users who watch stderr.
 *
 *   3. **No-op branch.** Already at latest, no cache yet (first run),
 *      or explicit opt-out of the entire feature.
 *
 * Opt-outs (environment only — mirrors the Claude Code CLI pattern
 * `DISABLE_AUTOUPDATER=1`; no config-file knob by design so the surface
 * stays a single string the user can grep their shell rc files for):
 *
 *   - `VALIS_DISABLE_AUTOUPDATER=1` — turns the auto-install spawn off,
 *     leaves the notice fallback enabled (user still sees the upgrade
 *     command, just runs it themselves).
 *   - `VALIS_NO_UPDATE_NOTIFIER=1` — legacy kill switch, disables BOTH
 *     auto-install AND notice. Retained as an alias for v0.5.3-era
 *     users who already set it.
 *
 * Constitution III: the notifier must never throw, never delay the
 * host hook by more than a few ms on the hot path, and never surface
 * as a failure. Install spawn is detached so the hook returns
 * immediately regardless of how long npm takes.
 */

import { spawn } from 'node:child_process';
import { mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { valisHome } from './paths.js';

const NPM_REGISTRY_URL = 'https://registry.npmjs.org/valis-cli/latest';
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 3000;

interface UpdateCacheRecord {
  checked_at: string;
  latest_version: string;
}

interface UpdatePendingRecord {
  /** Version `npm i -g` was invoked for. */
  target_version: string;
  /** ISO timestamp when the background install was spawned. */
  spawned_at: string;
  /** Best-effort: where the install log is written. */
  log_path: string;
}

/**
 * BUG #178 — sentinel written by the notice branch when auto-install is
 * blocked (version manager) but a newer CLI exists. UserPromptSubmit reads
 * it and emits `<valis_update_available>` so the user sees the upgrade
 * instruction in Claude Code's UI (stderr from session-start is unreliable
 * there). One emission per session: `last_emitted_session_id` is reset on
 * each session-start, and the consumer flips it on first qualifying prompt.
 */
interface UpdateAvailableRecord {
  /** Latest version on the registry. */
  target_version: string;
  /** Current installed version when the sentinel was written. */
  current_version: string;
  /** Why auto-install was skipped — drives the wording in the block. */
  reason: 'managed' | 'opt_out';
  /** ISO timestamp when the sentinel was written. */
  detected_at: string;
  /** Filled by UserPromptSubmit on first emission; resets on session-start. */
  last_emitted_session_id?: string;
}

function cachePath(): string {
  return join(valisHome(), 'cache', 'update-check.json');
}

function pendingPath(): string {
  return join(valisHome(), 'cache', 'update-pending.json');
}

function availablePath(): string {
  return join(valisHome(), 'cache', 'update-available.json');
}

function installLogPath(): string {
  return join(valisHome(), 'cache', 'update-install.log');
}

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
    /* non-fatal — next session retries */
  }
}

async function writePending(record: UpdatePendingRecord): Promise<void> {
  try {
    const target = pendingPath();
    await mkdir(dirname(target), { recursive: true });
    const tmp = `${target}.tmp`;
    await writeFile(tmp, JSON.stringify(record, null, 2), 'utf-8');
    await rename(tmp, target);
  } catch {
    /* non-fatal */
  }
}

async function writeAvailable(record: UpdateAvailableRecord): Promise<void> {
  try {
    const target = availablePath();
    await mkdir(dirname(target), { recursive: true });
    const tmp = `${target}.tmp`;
    await writeFile(tmp, JSON.stringify(record, null, 2), 'utf-8');
    await rename(tmp, target);
  } catch {
    /* non-fatal */
  }
}

/**
 * Drop the update-available sentinel — called when the user has caught up
 * (cached.latest <= currentVersion in the no-op branch) so we stop nagging.
 * Swallows ENOENT and any other error: the sentinel may not exist, and the
 * notifier must not throw from the hot path.
 */
async function clearAvailable(): Promise<void> {
  try {
    await unlink(availablePath());
  } catch {
    /* non-fatal */
  }
}

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
    /* network / parse / abort — swallowed */
  } finally {
    clearTimeout(timer);
  }
}

function cacheStale(record: UpdateCacheRecord | null): boolean {
  if (!record) return true;
  const ts = Date.parse(record.checked_at);
  if (!Number.isFinite(ts)) return true;
  return Date.now() - ts > CHECK_INTERVAL_MS;
}

interface AutoUpdatePreferences {
  /** True ⇒ user has not opted out of any update mechanism. */
  notifier_enabled: boolean;
  /** True ⇒ when a newer version is found and the env permits, try to install. */
  auto_install_enabled: boolean;
}

/**
 * Read the environment for the two opt-out switches. Defaults: both on
 * (auto-install enabled, notice fallback enabled). No config file is
 * consulted by design — opt-out lives in the environment so it travels
 * with the shell session the way `DISABLE_AUTOUPDATER` does for Claude
 * Code, and so users can flip it per-invocation without editing JSON.
 */
function readPreferences(): AutoUpdatePreferences {
  const truthy = (v: string | undefined): boolean => {
    if (!v) return false;
    const s = v.trim().toLowerCase();
    return s === '1' || s === 'true' || s === 'yes' || s === 'on';
  };
  const notifierOff = truthy(process.env.VALIS_NO_UPDATE_NOTIFIER);
  const autoInstallOff = truthy(process.env.VALIS_DISABLE_AUTOUPDATER);

  const notifierEnabled = !notifierOff;
  // Auto-install is on by default. Either explicit env switch turns it
  // off; legacy NO_UPDATE_NOTIFIER turns off the notice path too.
  const autoInstallEnabled = notifierEnabled && !autoInstallOff;
  return { notifier_enabled: notifierEnabled, auto_install_enabled: autoInstallEnabled };
}

/**
 * Resolve the global npm root and decide whether `npm i -g` is safe to
 * invoke here. Returns the global root path on success, or null when
 * (a) npm isn't on PATH, (b) the root resolves under a known version
 * manager (volta / asdf / nvm / brew / corepack / nodebrew / fnm), or
 * (c) the resolution fails for any reason. In all of those cases we
 * fall back to the notice path so the user runs the right command
 * under their manager's rules.
 */
async function resolveSafeNpmGlobalRoot(): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      const child = spawn('npm', ['root', '-g'], { stdio: ['ignore', 'pipe', 'ignore'] });
      let out = '';
      const timer = setTimeout(() => {
        try { child.kill(); } catch { /* ignore */ }
        resolve(null);
      }, 2000);
      child.stdout?.on('data', (chunk: Buffer) => {
        out += chunk.toString('utf-8');
      });
      child.on('error', () => {
        clearTimeout(timer);
        resolve(null);
      });
      child.on('exit', (code) => {
        clearTimeout(timer);
        if (code !== 0) return resolve(null);
        const root = out.trim();
        if (!root) return resolve(null);
        // Known version-manager paths — `npm i -g` here either fails or
        // writes to the wrong shim, so we hand control back to the user.
        const managed =
          /\.volta\b/.test(root) ||
          /\.asdf\b/.test(root) ||
          /\.nvm\b/.test(root) ||
          /\.fnm\b/.test(root) ||
          /\.nodebrew\b/.test(root) ||
          /[Hh]omebrew/.test(root) ||
          /\.corepack\b/.test(root);
        if (managed) return resolve(null);
        resolve(root);
      });
    } catch {
      resolve(null);
    }
  });
}

/**
 * Spawn `npm i -g valis-cli@latest` detached and unref'd so the host
 * hook returns immediately. stdio is routed to the install log file
 * so the user (and the next session-start) can inspect what happened.
 *
 * Returns whether the spawn itself succeeded; the install may still
 * fail asynchronously, but that's reflected in the log file, not the
 * boolean.
 */
async function spawnDetachedInstall(targetVersion: string): Promise<boolean> {
  try {
    const logPath = installLogPath();
    await mkdir(dirname(logPath), { recursive: true });
    const fh = await open(logPath, 'a');
    const header = `\n=== ${new Date().toISOString()} — installing valis-cli@${targetVersion} ===\n`;
    await fh.write(header);
    const fd = fh.fd;

    const child = spawn('npm', ['i', '-g', `valis-cli@${targetVersion}`], {
      detached: true,
      stdio: ['ignore', fd, fd],
      env: process.env,
    });
    child.unref();
    // Don't await the close — we want the host hook to keep going.
    // The fd belongs to the child now; closing here would NOT cut its
    // pipe (the dup'd fd stays open inside the spawned process).
    void fh.close().catch(() => undefined);
    return true;
  } catch {
    return false;
  }
}

function emitNotice(
  currentVersion: string,
  latestVersion: string,
  reason: 'managed' | 'opt_out',
): void {
  try {
    const why =
      reason === 'managed'
        ? `\n  Detected a version-managed install (volta / asdf / nvm / brew). ` +
          `Auto-install was skipped — run the upgrade under your manager.`
        : '';
    process.stderr.write(
      `valis-cli ${latestVersion} available (you have ${currentVersion}). ` +
        `Run: npm i -g valis-cli@latest${why}\n`,
    );
  } catch {
    /* stderr closed — silent */
  }
}

/**
 * Main entry point. Branches between auto-install, notice, and no-op.
 * Returns the action taken (for tests / telemetry); host hooks don't
 * need to inspect this.
 */
export async function maybeNotifyOfUpdate(
  currentVersion: string,
): Promise<'auto_installed' | 'notice_emitted' | 'noop'> {
  const prefs = readPreferences();
  if (!prefs.notifier_enabled) {
    // BUG #178: legacy kill-switch silences EVERYTHING including the
    // additionalContext block — clear any stale sentinel so we don't keep
    // nagging the agent after the user explicitly opted out.
    await clearAvailable();
    return 'noop';
  }

  let cached: UpdateCacheRecord | null = null;
  try {
    cached = await readCache();
  } catch {
    cached = null;
  }

  // Always refresh the cache in the background when stale — keeps the
  // notice/auto-install accurate for the NEXT session even if this run
  // takes no action.
  if (cacheStale(cached)) {
    void refreshCache();
  }

  if (!cached || compareVersions(cached.latest_version, currentVersion) <= 0) {
    // User has caught up (or first run) — purge the sentinel.
    await clearAvailable();
    return 'noop';
  }

  // From here on, a newer version IS available.

  /**
   * Write the `<valis_update_available>` sentinel for this session-start.
   * Resets `last_emitted_session_id` to undefined so the UserPromptSubmit
   * consumer emits the block once at the next qualifying prompt of THIS
   * Claude Code session. Reason drives wording so the user sees an
   * actionable, manager-aware instruction.
   */
  const writeAvailableSentinel = (reason: 'managed' | 'opt_out'): Promise<void> =>
    writeAvailable({
      target_version: cached!.latest_version,
      current_version: currentVersion,
      reason,
      detected_at: new Date().toISOString(),
    });

  if (prefs.auto_install_enabled) {
    const safeRoot = await resolveSafeNpmGlobalRoot();
    if (safeRoot) {
      const spawned = await spawnDetachedInstall(cached.latest_version);
      if (spawned) {
        await writePending({
          target_version: cached.latest_version,
          spawned_at: new Date().toISOString(),
          log_path: installLogPath(),
        });
        // Auto-install is happening — drop the manual-action sentinel.
        await clearAvailable();
        return 'auto_installed';
      }
      // Spawn failed — fall through to notice as the last-resort signal.
      emitNotice(currentVersion, cached.latest_version, 'opt_out');
      await writeAvailableSentinel('opt_out');
      return 'notice_emitted';
    }
    emitNotice(currentVersion, cached.latest_version, 'managed');
    await writeAvailableSentinel('managed');
    return 'notice_emitted';
  }

  emitNotice(currentVersion, cached.latest_version, 'opt_out');
  await writeAvailableSentinel('opt_out');
  return 'notice_emitted';
}

export const __test__ = {
  compareVersions,
  cacheStale,
  readPreferences,
  resolveSafeNpmGlobalRoot,
};
