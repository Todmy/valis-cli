/**
 * Proxy layer that forwards MCP tool calls to a remote Streamable HTTP
 * endpoint. Uses native fetch — no extra dependencies.
 */

let requestId = 0;

export class ProxyError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = 'ProxyError';
  }
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: { content: unknown[] };
  error?: { code: number; message: string; data?: unknown };
}

function buildRequest(method: string, params: Record<string, unknown>) {
  return { jsonrpc: '2.0' as const, id: ++requestId, method, params };
}

async function rpc(
  endpoint: string,
  token: string,
  method: string,
  params: Record<string, unknown>,
): Promise<JsonRpcResponse> {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify(buildRequest(method, params)),
  });

  if (!res.ok) {
    throw new ProxyError(
      `MCP proxy: ${res.status} ${res.statusText}`,
      res.status,
    );
  }

  const json = (await res.json()) as JsonRpcResponse;
  if (json.error) {
    throw new ProxyError(
      `MCP remote error ${json.error.code}: ${json.error.message}`,
      -1,
    );
  }
  return json;
}

/** Send the MCP initialize handshake. Call once at proxy startup. */
export async function initializeProxy(
  mcpEndpoint: string,
  bearerToken: string,
): Promise<Record<string, unknown>> {
  const res = await rpc(mcpEndpoint, bearerToken, 'initialize', {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'valis-cli', version: '0.1.7' },
  });
  return (res.result ?? {}) as Record<string, unknown>;
}

/** Forward a single tool call and return the content blocks. */
export async function proxyToolCall(
  mcpEndpoint: string,
  bearerToken: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<unknown[]> {
  const res = await rpc(mcpEndpoint, bearerToken, 'tools/call', {
    name: toolName,
    arguments: args,
  });
  return res.result?.content ?? [];
}
