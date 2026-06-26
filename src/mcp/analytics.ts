/**
 * MCP tool-call analytics — BUG #183 fix.
 *
 * Wraps every tool handler in `createMcpServer` with a thin instrumentation
 * layer that emits `mcp_tool_call` after each invocation. Without this, Valis
 * has zero signal on which tools agents actually call, with what latency, or
 * what their success/error rate is — the single richest usage source for a
 * CLI-plus-plugin product was completely dark before this module landed.
 *
 * Design contract:
 *   1. Best-effort. Analytics MUST NEVER throw into a handler path. The
 *      handler's resolved value (or thrown error) is returned/re-thrown
 *      verbatim, regardless of emit outcome.
 *   2. Stdio-mode safe. When `configOverride` is undefined or has no
 *      `emit_funnel` (the local dev path), the wrapper is effectively a
 *      no-op around the original handler.
 *   3. No-double-count. Only `createMcpServer` is wrapped. The proxy server
 *      forwards calls to a remote `createMcpServer` where instrumentation
 *      already runs — wrapping both would inflate counts.
 *   4. Privacy-minimal payload. `target_project_id_passed` records the
 *      presence of cross-org reads (feature 033) WITHOUT leaking the
 *      target project's UUID into telemetry.
 */

import type { ServerConfig } from '../types.js';

const ANALYTICS_EVENT = 'mcp_tool_call';
const ERROR_MESSAGE_MAX = 200;

type HandlerArgs = Record<string, unknown>;
type HandlerResult = { content: Array<{ type: 'text'; text: string }> };
type Handler = (args: HandlerArgs) => Promise<HandlerResult>;

interface AnalyticsPayload extends Record<string, unknown> {
  tool: string;
  duration_ms: number;
  success: boolean;
  member_id: string;
  org_id: string;
  project_id?: string;
  target_project_id_passed?: boolean;
  result_count?: number;
  decision_type?: string;
  error_code?: string;
  error_message?: string;
}

function classifyError(err: unknown): { code: string; message: string } {
  if (err instanceof Error) {
    const codeField = (err as Error & { code?: unknown }).code;
    const code = typeof codeField === 'string' ? codeField : err.name || 'unknown_error';
    const message = err.message.length > ERROR_MESSAGE_MAX
      ? `${err.message.slice(0, ERROR_MESSAGE_MAX)}…`
      : err.message;
    return { code, message };
  }
  return { code: 'unknown_error', message: String(err).slice(0, ERROR_MESSAGE_MAX) };
}

function buildPayload(
  toolName: string,
  durationMs: number,
  config: ServerConfig | undefined,
  args: HandlerArgs,
  outcome: { success: true } | { success: false; error: unknown },
): AnalyticsPayload {
  const payload: AnalyticsPayload = {
    tool: toolName,
    duration_ms: durationMs,
    success: outcome.success,
    member_id: config?.member_id ?? 'unknown',
    org_id: config?.org_id ?? 'unknown',
  };

  if (config?.project_id) {
    payload.project_id = config.project_id;
  }

  // Feature 033 (public-KB read): record whether the call carried a
  // cross-org read flag, without leaking the target project's UUID.
  if (args && typeof args === 'object' && 'target_project_id' in args && args.target_project_id) {
    payload.target_project_id_passed = true;
  }

  if (!outcome.success) {
    const { code, message } = classifyError(outcome.error);
    payload.error_code = code;
    payload.error_message = message;
  }

  return payload;
}

function safeEmit(
  config: ServerConfig | undefined,
  payload: AnalyticsPayload,
): void {
  if (!config?.emit_funnel) return;
  try {
    config.emit_funnel(ANALYTICS_EVENT, payload);
  } catch (err) {
    // Analytics failure MUST NOT propagate. Log to stderr (visible in Vercel
    // function logs) so genuine misconfiguration is still investigable.
    console.warn(
      `[mcp-analytics] emit failed for ${payload.tool}:`,
      (err as Error).message,
    );
  }
}

/**
 * Wrap a tool handler so each invocation emits `mcp_tool_call` analytics.
 *
 * Usage in createMcpServer:
 *   registerToolFromDef(server, 'valis_search', wrapToolWithAnalytics(
 *     'valis_search',
 *     configOverride,
 *     async (args) => handleSearch(args, configOverride).then(toContent),
 *   ));
 */
export function wrapToolWithAnalytics(
  toolName: string,
  configOverride: ServerConfig | undefined,
  handler: Handler,
  extractResultMeta?: (result: unknown) => { result_count?: number; decision_type?: string },
): Handler {
  return async (args: HandlerArgs): Promise<HandlerResult> => {
    const start = Date.now();
    try {
      const result = await handler(args);
      const payload = buildPayload(toolName, Date.now() - start, configOverride, args, {
        success: true,
      });
      // T2.1: best-effort result-meta enrichment. Never let an extractor
      // failure break the handler path — swallow and emit the base payload.
      if (extractResultMeta) {
        try {
          const meta = extractResultMeta(result);
          if (meta && typeof meta.result_count === 'number') {
            payload.result_count = meta.result_count;
          }
          if (meta && typeof meta.decision_type === 'string') {
            payload.decision_type = meta.decision_type;
          }
        } catch {
          // Extractor threw — keep the base payload.
        }
      }
      safeEmit(configOverride, payload);
      return result;
    } catch (err) {
      const payload = buildPayload(toolName, Date.now() - start, configOverride, args, {
        success: false,
        error: err,
      });
      safeEmit(configOverride, payload);
      throw err;
    }
  };
}
