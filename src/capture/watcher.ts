import { watch } from 'chokidar';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

const STATE_FILE = join(homedir(), '.valis', 'watcher-state.json');
const WATCH_PATTERN = join(homedir(), '.claude', 'projects', '**', '*.jsonl');
const ACTIVITY_THRESHOLD_MS = 15 * 60 * 1000; // 15 minutes

interface WatcherState {
  offsets: Record<string, number>;
  last_activity: Record<string, string>;
}

type ActivityCallback = (filePath: string) => void;

let state: WatcherState = { offsets: {}, last_activity: {} };

async function loadState(): Promise<void> {
  try {
    const data = await readFile(STATE_FILE, 'utf-8');
    state = JSON.parse(data);
  } catch {
    state = { offsets: {}, last_activity: {} };
  }
}

export async function saveState(): Promise<void> {
  const dir = join(homedir(), '.valis');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(STATE_FILE, JSON.stringify(state, null, 2), { mode: 0o600 });
}

export function startWatcher(onActivity: ActivityCallback): ReturnType<typeof watch> {
  const watcher = watch(WATCH_PATTERN, {
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: {
      stabilityThreshold: 500,
      pollInterval: 100,
    },
  });

  watcher.on('change', async (filePath) => {
    const now = new Date().toISOString();
    const lastActivity = state.last_activity[filePath];

    // Track byte offset for incremental processing
    try {
      const fileStats = await stat(filePath);
      state.offsets[filePath] = fileStats.size;
    } catch {
      // File may have been removed
    }

    if (lastActivity) {
      const elapsed = Date.now() - new Date(lastActivity).getTime();
      if (elapsed >= ACTIVITY_THRESHOLD_MS) {
        onActivity(filePath);
      }
    }

    state.last_activity[filePath] = now;
  });

  watcher.on('add', async (filePath) => {
    state.last_activity[filePath] = new Date().toISOString();
    try {
      const fileStats = await stat(filePath);
      state.offsets[filePath] = fileStats.size;
    } catch {
      state.offsets[filePath] = 0;
    }
  });

  // gh#342 — chokidar surfaces fd exhaustion (EMFILE) through 'error'. Without a
  // listener Node rethrows it as an unhandled 'error' event and kills the whole
  // process, which in `valis serve` means the MCP handshake dies with no
  // diagnostic. EMFILE fires once per failing path, so log once and shut the
  // watcher down — activity detection is best-effort, the MCP server is not.
  let errorReported = false;
  watcher.on('error', (err) => {
    if (errorReported) return;
    errorReported = true;
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `[watcher] Stopped after a file-watch error (EMFILE / too many open files is the usual cause): ${message}. ` +
        'MCP tools are unaffected; only activity detection is off for this session. ' +
        'Raise the fd limit (ulimit -n) to recover, or keep the watcher off by unsetting VALIS_DISABLE_WATCHER.',
    );
    watcher.close().catch(() => {
      // Already tearing down — nothing further to do.
    });
    // close() synchronously drops every listener, including this one, while
    // further EMFILE errors can still arrive from in-flight fs callbacks.
    // Re-arm a silent listener so a late error stays a no-op instead of an
    // unhandled 'error' event.
    watcher.on('error', () => {});
  });

  return watcher;
}

export function getWatcherState(): WatcherState {
  return state;
}

export { loadState as initWatcherState };
