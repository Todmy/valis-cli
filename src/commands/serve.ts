import { loadConfig } from '../config/store.js';
import { startMcpServer } from '../mcp/server.js';
import { startWatcher, saveState, initWatcherState } from '../capture/watcher.js';
import { startHookHandler, stopHookHandler } from '../capture/hook-handler.js';
import { startupSweep } from '../capture/startup-sweep.js';
import { buildCaptureReminder } from '../channel/push.js';

export async function serveCommand(): Promise<void> {
  const config = await loadConfig();
  if (!config) {
    console.error('Error: Teamind not configured. Run `teamind init` first.');
    process.exit(1);
  }

  // 1. Startup sweep (async, non-blocking)
  startupSweep()
    .then((result) => {
      if (result.queued_flushed > 0) {
        console.error(`Startup sweep: flushed ${result.queued_flushed} queued decisions`);
      }
    })
    .catch((err) => {
      console.error(`Startup sweep error: ${(err as Error).message}`);
    });

  // 2. Init watcher state
  await initWatcherState();

  // 3. Start JSONL activity watcher
  const watcher = startWatcher((filePath) => {
    console.error(`Activity detected: ${filePath}`);
    // Channel push would happen here if channels are connected
    const _reminder = buildCaptureReminder();
  });

  // 4. Start stop hook handler
  try {
    await startHookHandler((_event, _data) => {
      console.error('Stop hook received — sending capture reminder');
    });
  } catch (err) {
    console.error(`Hook handler error: ${(err as Error).message}`);
  }

  // 5. Start MCP server (blocks on stdio)
  // Cleanup on exit
  process.on('SIGINT', async () => {
    await saveState();
    stopHookHandler();
    await watcher.close();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    await saveState();
    stopHookHandler();
    await watcher.close();
    process.exit(0);
  });

  await startMcpServer();
}
