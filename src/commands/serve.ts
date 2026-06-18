import { loadConfig } from '../config/store.js';
import { findProjectConfig } from '../config/project.js';
import { createMcpServer, createProxyMcpServer } from '../mcp/server.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { startWatcher, saveState, initWatcherState } from '../capture/watcher.js';
import { startHookHandler, stopHookHandler } from '../capture/hook-handler.js';
import { startupSweep } from '../capture/startup-sweep.js';
import { buildCaptureReminder } from '../channel/push.js';
import { getSupabaseClient } from '../cloud/supabase.js';
import { subscribe, type RealtimeSubscription } from '../cloud/realtime.js';
import { setRealtimeStatus, type RealtimeStatus } from './status.js';
import { isHostedMode, resolveMcpEndpoint } from '../cloud/api-url.js';
import { assertSchemaCompatible, SchemaOutOfDateError } from '../cloud/schema-guard.js';
import { flushQueue } from '../offline/queue.js';

export async function serveCommand(): Promise<void> {
  const config = await loadConfig();
  if (!config) {
    console.error('Error: Valis not configured. Run `valis init` first.');
    process.exit(1);
  }

  // #299 — Community mode only: block startup if the self-host DB schema is
  // behind what this CLI expects (Hosted skips — the server owns the schema).
  try {
    await assertSchemaCompatible(config, undefined, (m) => console.error(m));
  } catch (err) {
    if (err instanceof SchemaOutOfDateError) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
    // Ledger unreadable (e.g. fresh DB still booting) — do not hard-block serve
    // on a transient read error; surface it and continue.
    console.error(`[schema-guard] skipped: ${(err as Error).message}`);
  }

  // T030: Resolve project config from .valis.json for project-scoped Realtime
  const projectConfig = await findProjectConfig(process.cwd());
  const projectId = projectConfig?.project_id;
  const projectName = projectConfig?.project_name;

  if (projectName) {
    console.error(`[project] Active project: ${projectName} (${projectId})`);
  } else {
    console.error('[project] No project configured — using org-level subscription');
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

  // 3. Start JSONL activity watcher (gated — disabled by default; re-enable
  //    via VALIS_DISABLE_WATCHER=0). Watcher currently only activity-logs
  //    and does NOT auto-extract decisions; explicit-off prevents partial-on
  //    confusion when #91 Level 1 ships future auto-extraction. Tracked in
  //    BACKLOG: re-enable after #91 Level 1 lands.
  const watcherEnabled = process.env.VALIS_DISABLE_WATCHER === '0';
  const watcher = watcherEnabled
    ? startWatcher((filePath) => {
        console.error(`Activity detected: ${filePath}`);
        // Channel push would happen here if channels are connected
        const _reminder = buildCaptureReminder();
      })
    : null;
  if (!watcherEnabled) {
    console.error('[watcher] Disabled by default (set VALIS_DISABLE_WATCHER=0 to enable). Pending #91 Level 1.');
  }

  // 4. Start stop hook handler
  try {
    await startHookHandler((_event, _data) => {
      console.error('Stop hook received — sending capture reminder');
    });
  } catch (err) {
    console.error(`Hook handler error: ${(err as Error).message}`);
  }

  // 5. Create MCP server — proxy mode in hosted, local in community
  const proxyMode = isHostedMode(config);
  let mcpServer;
  if (proxyMode) {
    console.error('[proxy] Hosted mode — routing through cloud endpoint');
    // T006: Flush offline queue at session start
    try {
      const endpoint = resolveMcpEndpoint(config);
      const token = config.member_api_key || config.api_key;
      const { synced, failed } = await flushQueue(endpoint, token);
      if (synced > 0 || failed > 0) {
        console.error(`[proxy] Queue flush: ${synced} synced, ${failed} failed`);
      }
    } catch {
      console.error('[proxy] Queue flush failed — will retry on next startup');
    }
    mcpServer = createProxyMcpServer(config);
  } else {
    mcpServer = createMcpServer();
  }

  // 6. Subscribe to Supabase Realtime for cross-session push (T019)
  let realtimeSub: RealtimeSubscription | null = null;
  try {
    const supabase = getSupabaseClient(
      config.supabase_url,
      config.supabase_service_role_key,
    );

    realtimeSub = subscribe(supabase, config.org_id, projectId, {
      localAuthor: config.author_name,
      onEvent: (event) => {
        // Push to local MCP channel via server logging notification
        try {
          mcpServer.server
            .sendLoggingMessage({
              level: 'info',
              logger: 'valis-realtime',
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
        const channelLabel = projectId
          ? `project:${projectName ?? projectId}`
          : `org:${config.org_id}`;
        if (status === 'degraded') {
          console.error('[realtime] Connection degraded — pull-based tools still work');
        } else if (status === 'disconnected') {
          console.error('[realtime] Disconnected');
        } else if (status === 'connected') {
          console.error(`[realtime] Connected to ${channelLabel} channel`);
        }
      },
    });

    const subscribeLabel = projectId
      ? `project:${projectId}`
      : `org:${config.org_id}`;
    console.error(`[realtime] Subscribing to ${subscribeLabel}...`);
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
    if (watcher) await watcher.close();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    if (realtimeSub) {
      await realtimeSub.unsubscribe();
    }
    await saveState();
    stopHookHandler();
    if (watcher) await watcher.close();
    process.exit(0);
  });

  // 8. Start MCP server (blocks on stdio)
  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);
  console.error('Valis MCP server running (stdio)');
}
