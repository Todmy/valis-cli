import { describe, it, expect, beforeEach } from 'vitest';
import { appendToQueue, readQueue, flushQueue, getCount } from '../../src/offline/queue.js';

describe('Offline Queue', () => {
  beforeEach(async () => {
    await flushQueue();
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

  it('flushes queue', async () => {
    await appendToQueue({ text: 'Will be flushed decision' }, 'author', 'mcp_store');
    await flushQueue();
    const count = await getCount();
    expect(count).toBe(0);
  });
});
