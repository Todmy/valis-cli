import { watch } from 'chokidar';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

const STATE_FILE = join(homedir(), '.teamind', 'watcher-state.json');
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
  const dir = join(homedir(), '.teamind');
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

  return watcher;
}

export function getWatcherState(): WatcherState {
  return state;
}

export { loadState as initWatcherState };
