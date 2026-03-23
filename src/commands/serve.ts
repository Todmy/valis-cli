import { loadConfig } from '../config/store.js';
import { createMcpServer } from '../mcp/server.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { startWatcher, saveState, initWatcherState } from '../capture/watcher.js';
import { startHookHandler, stopHookHandler } from '../capture/hook-handler.js';
import { startupSweep } from '../capture/startup-sweep.js';
import { buildCaptureReminder } from '../channel/push.js';
import { getSupabaseClient } from '../cloud/supabase.js';
import { subscribeToOrg, type RealtimeSubscription } from '../cloud/realtime.js';
import { setRealtimeStatus, type RealtimeStatus } from './status.js';

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

  // 5. Create MCP server (we need the reference for channel push)
  const mcpServer = createMcpServer();

  // 6. Subscribe to Supabase Realtime for cross-session push (T019)
  let realtimeSub: RealtimeSubscription | null = null;
  try {
    const supabase = getSupabaseClient(
      config.supabase_url,
      config.supabase_service_role_key,
    );

    realtimeSub = subscribeToOrg(supabase, config.org_id, {
      localAuthor: config.author_name,
      onEvent: (event) => {
        // Push to local MCP channel via server logging notification
        try {
          mcpServer.server
            .sendLoggingMessage({
              level: 'info',
              logger: 'teamind-realtime',
              data: event,
            })
            .catch(() => {
              // Best-effort push — ignore if client disconnected
            });
        } catch {
          // MCP server not connected yet or transport error — ignore
        }
        console.error(
          `[realtime] ${event.event}: ${event.content.substring(0, 80)}`,
        );
      },
      onError: (error) => {
        console.error(`[realtime] Error: ${error.message}`);
      },
      onStatusChange: (status: RealtimeStatus) => {
        setRealtimeStatus(status);
        if (status === 'degraded') {
          console.error('[realtime] Connection degraded — pull-based tools still work');
        } else if (status === 'disconnected') {
          console.error('[realtime] Disconnected');
        } else if (status === 'connected') {
          console.error('[realtime] Connected to org channel');
        }
      },
    });

    console.error(`[realtime] Subscribing to org:${config.org_id}...`);
  } catch (err) {
    console.error(
      `[realtime] Failed to subscribe: ${(err as Error).message}. ` +
        'Cross-session push disabled — pull-based tools still work.',
    );
  }

  // 7. Cleanup on exit
  process.on('SIGINT', async () => {
    if (realtimeSub) {
      await realtimeSub.unsubscribe();
    }
    await saveState();
    stopHookHandler();
    await watcher.close();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    if (realtimeSub) {
      await realtimeSub.unsubscribe();
    }
    await saveState();
    stopHookHandler();
    await watcher.close();
    process.exit(0);
  });

  // 8. Start MCP server (blocks on stdio)
  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);
  console.error('Teamind MCP server running (stdio)');
}
