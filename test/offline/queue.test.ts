import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  appendToQueue,
  readQueue,
  clearQueue,
  getCount,
  flushQueue,
} from '../../src/offline/queue.js';

describe('Offline Queue', () => {
  beforeEach(async () => {
    await clearQueue();
  });

  it('appends and reads entries', async () => {
    const id = await appendToQueue(
      { text: 'Test decision for queue' },
      'test-author',
      'mcp_store',
    );

    expect(id).toBeDefined();

    const entries = await readQueue();
    expect(entries.length).toBeGreaterThanOrEqual(1);
    expect(entries.some((e) => e.id === id)).toBe(true);
  });

  it('counts entries', async () => {
    await appendToQueue({ text: 'Decision one for count test' }, 'author', 'mcp_store');
    await appendToQueue({ text: 'Decision two for count test' }, 'author', 'mcp_store');
    const count = await getCount();
    expect(count).toBeGreaterThanOrEqual(2);
  });

  it('clears queue', async () => {
    await appendToQueue({ text: 'Will be cleared decision' }, 'author', 'mcp_store');
    await clearQueue();
    const count = await getCount();
    expect(count).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 036/FR-003 (#90) — flushQueue must forward the persisted status (and the
// project scope) into the reconstructed valis_store arguments. Regression for
// the BLOCKER: dropping `status` let the server apply `status ?? 'proposed'`,
// silently degrading an explicit 'active' to 'proposed' for every proxy/plugin
// user on the dominant deployment path.
// ---------------------------------------------------------------------------
describe('flushQueue — status + project_id forwarding (#90)', () => {
  beforeEach(async () => {
    await clearQueue();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** Capture the JSON-RPC bodies POSTed to the MCP endpoint. */
  function stubFetchOk(): { bodies: Array<Record<string, unknown>> } {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchMock = vi.fn(async (_url: unknown, init: { body: string }) => {
      bodies.push(JSON.parse(init.body) as Record<string, unknown>);
      return { ok: true } as Response;
    });
    vi.stubGlobal('fetch', fetchMock);
    return { bodies };
  }

  it("forwards an explicit 'active' status and project_id into valis_store args", async () => {
    await appendToQueue(
      { text: 'Use RS256 JWT', project_id: 'proj-active', session_id: 'sess-1' },
      'olena',
      'mcp_store',
      'active',
    );

    const { bodies } = stubFetchOk();
    const result = await flushQueue('https://valis.example/api/mcp', 'tok-1');

    expect(result).toEqual({ synced: 1, failed: 0, remaining: 0 });
    expect(bodies).toHaveLength(1);
    const args = (bodies[0].params as { arguments: Record<string, unknown> })
      .arguments;
    // The BLOCKER fix: status survives the flush instead of being dropped.
    expect(args.status).toBe('active');
    // project_id was already forwarded — lock it so the latent unscoped-write
    // regression can't reappear at the same reconstruction site.
    expect(args.project_id).toBe('proj-active');
    expect(args.text).toBe('Use RS256 JWT');

    // Queue is emptied on success.
    expect(await getCount()).toBe(0);
  });

  it("forwards an explicit 'proposed' status into valis_store args", async () => {
    await appendToQueue(
      { text: 'Adopt feature flags', project_id: 'proj-prop' },
      'mark',
      'mcp_store',
      'proposed',
    );

    const { bodies } = stubFetchOk();
    await flushQueue('https://valis.example/api/mcp', 'tok-1');

    const args = (bodies[0].params as { arguments: Record<string, unknown> })
      .arguments;
    expect(args.status).toBe('proposed');
    expect(args.project_id).toBe('proj-prop');
  });

  it('omits status for legacy entries written before the status field existed', async () => {
    // No status argument → entry has no `status` key → flush must not inject a
    // value, so the server default still applies to legacy entries.
    await appendToQueue({ text: 'Legacy decision', project_id: 'proj-legacy' }, 'sam', 'mcp_store');

    const { bodies } = stubFetchOk();
    await flushQueue('https://valis.example/api/mcp', 'tok-1');

    const args = (bodies[0].params as { arguments: Record<string, unknown> })
      .arguments;
    expect('status' in args).toBe(false);
    expect(args.project_id).toBe('proj-legacy');
  });
});
