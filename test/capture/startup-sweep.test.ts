import { describe, it, expect, vi, beforeEach } from 'vitest';

// loadConfig: default null (unconfigured) for the baseline test; overridden
// per-test for the flush-path tests.
const loadConfigMock = vi.fn().mockResolvedValue(null);
vi.mock('../../src/config/store.js', () => ({
  loadConfig: () => loadConfigMock(),
}));

// Supabase + Qdrant write spies. We assert the *written* status extras so the
// read-path `?? 'active'` fallback cannot mask a regression (036/US2, #90).
const storeDecisionSpy = vi.fn();
const getSupabaseClientMock = vi.fn().mockReturnValue({});
vi.mock('../../src/cloud/supabase.js', () => ({
  getSupabaseClient: (...args: unknown[]) => getSupabaseClientMock(...args),
  storeDecision: (...args: unknown[]) => storeDecisionSpy(...args),
}));

const upsertDecisionSpy = vi.fn().mockResolvedValue(undefined);
const getQdrantClientMock = vi.fn().mockReturnValue({});
vi.mock('../../src/cloud/qdrant.js', () => ({
  getQdrantClient: (...args: unknown[]) => getQdrantClientMock(...args),
  upsertDecision: (...args: unknown[]) => upsertDecisionSpy(...args),
}));

const readQueueMock = vi.fn();
const clearQueueMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../../src/offline/queue.js', () => ({
  readQueue: () => readQueueMock(),
  clearQueue: () => clearQueueMock(),
}));

import { startupSweep } from '../../src/capture/startup-sweep.js';

const FAKE_CONFIG = {
  org_id: 'org-1',
  supabase_url: 'https://example.supabase.co',
  supabase_service_role_key: 'svc',
  qdrant_url: 'https://example.qdrant.io',
  qdrant_api_key: 'qkey',
};

describe('Startup Sweep', () => {
  beforeEach(() => {
    loadConfigMock.mockResolvedValue(null);
    readQueueMock.mockReset();
    storeDecisionSpy.mockReset();
    upsertDecisionSpy.mockReset().mockResolvedValue(undefined);
    clearQueueMock.mockReset().mockResolvedValue(undefined);
  });

  it('returns zero counts when not configured', async () => {
    const result = await startupSweep();
    expect(result.processed).toBe(0);
    expect(result.queued_flushed).toBe(0);
    expect(result.errors).toBe(0);
  });

  // 036/US2 (#90): a queued `proposed` decision must retain its status in the
  // Qdrant payload after flush — not flatten to `active`.
  it('preserves queued status (proposed) in the Qdrant payload on flush', async () => {
    loadConfigMock.mockResolvedValue(FAKE_CONFIG);
    storeDecisionSpy.mockResolvedValue({ id: 'dec-1' });
    readQueueMock.mockResolvedValue([
      {
        id: 'q-1',
        decision: { text: 'use postgres', project_id: 'proj-1' },
        author: 'olena',
        source: 'mcp_store',
        status: 'proposed',
        queued_at: new Date().toISOString(),
      },
    ]);

    const result = await startupSweep();

    expect(result.queued_flushed).toBe(1);
    expect(result.errors).toBe(0);
    // Postgres write carries the queued status.
    expect(storeDecisionSpy.mock.calls[0][5]).toMatchObject({ status: 'proposed' });
    // Qdrant payload extras carry the queued status.
    expect(upsertDecisionSpy.mock.calls[0][5]).toMatchObject({ status: 'proposed' });
  });

  it('defaults to active when the queued entry has no status', async () => {
    loadConfigMock.mockResolvedValue(FAKE_CONFIG);
    storeDecisionSpy.mockResolvedValue({ id: 'dec-2' });
    readQueueMock.mockResolvedValue([
      {
        id: 'q-2',
        decision: { text: 'use redis', project_id: 'proj-1' },
        author: 'olena',
        source: 'mcp_store',
        queued_at: new Date().toISOString(),
      },
    ]);

    const result = await startupSweep();

    expect(result.queued_flushed).toBe(1);
    // No status threaded → both writes leave status undefined; storeDecision
    // and upsertDecision each apply their own `'active'` default downstream.
    expect(storeDecisionSpy.mock.calls[0][5]?.status).toBeUndefined();
    expect(upsertDecisionSpy.mock.calls[0][5]?.status).toBeUndefined();
  });
});
