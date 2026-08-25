/**
 * gh#331 — the remote `isError` flag must survive the proxy hop.
 *
 * The MCP SDK (`@modelcontextprotocol/sdk` 1.27.1, `server/mcp.js`
 * `createToolError`) turns a thrown tool handler into a *successful* JSON-RPC
 * result carrying `isError: true`. Dropping that flag delivers every failed
 * tool call to proxy-mode clients as ordinary content — a silent failure
 * presented as an answer.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { proxyToolCall } from '../../src/mcp/proxy.js';

const ENDPOINT = 'https://example.invalid/api/mcp';
const TOKEN = 'test-token';

function mockRpcResult(result: unknown) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => ({ jsonrpc: '2.0', id: 1, result }),
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('proxyToolCall — isError propagation (gh#331)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('preserves isError: true from the remote result', async () => {
    mockRpcResult({
      content: [{ type: 'text', text: 'boom: handler threw' }],
      isError: true,
    });

    const res = await proxyToolCall(ENDPOINT, TOKEN, 'valis_search', { query: 'x' });

    expect(res.isError).toBe(true);
    expect(res.content).toEqual([{ type: 'text', text: 'boom: handler threw' }]);
  });

  it('leaves isError absent on a normal success (does not emit false)', async () => {
    mockRpcResult({ content: [{ type: 'text', text: '{"results":[]}' }] });

    const res = await proxyToolCall(ENDPOINT, TOKEN, 'valis_search', { query: 'x' });

    expect(res.content).toEqual([{ type: 'text', text: '{"results":[]}' }]);
    expect('isError' in res).toBe(false);
  });

  it('preserves an explicit isError: false when the remote sets it', async () => {
    mockRpcResult({ content: [], isError: false });

    const res = await proxyToolCall(ENDPOINT, TOKEN, 'valis_store', { text: 'x' });

    expect(res.isError).toBe(false);
  });

  it('returns an empty content array when the remote omits content', async () => {
    mockRpcResult({});

    const res = await proxyToolCall(ENDPOINT, TOKEN, 'valis_context', {});

    expect(res.content).toEqual([]);
    expect('isError' in res).toBe(false);
  });
});

describe('createProxyMcpServer — isError reaches the client (gh#331)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function callViaProxyServer(remoteResult: unknown) {
    const { createProxyMcpServer } = await import('../../src/mcp/server.js');
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');

    mockRpcResult(remoteResult);

    const server = createProxyMcpServer({
      supabase_url: 'https://example.invalid',
      member_api_key: TOKEN,
    } as never);

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '0.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    try {
      return await client.callTool({ name: 'valis_search', arguments: { query: 'x' } });
    } finally {
      await client.close();
      await server.close();
    }
  }

  it('flags a failed upstream tool call as isError', async () => {
    const res = await callViaProxyServer({
      content: [{ type: 'text', text: 'upstream handler threw' }],
      isError: true,
    });

    expect(res.isError).toBe(true);
    expect(res.content).toEqual([{ type: 'text', text: 'upstream handler threw' }]);
  });

  it('leaves a normal success unflagged', async () => {
    const res = await callViaProxyServer({
      content: [{ type: 'text', text: '{"results":[]}' }],
    });

    expect(res.isError).toBeUndefined();
    expect(res.content).toEqual([{ type: 'text', text: '{"results":[]}' }]);
  });
});
