import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  runQdrantHeal,
  QDRANT_INDEXES,
  QDRANT_COLLECTIONS,
} from '../../src/hooks/qdrant-self-heal.js';

let tempHome: string;
let prevValisHome: string | undefined;
let prevFetch: typeof globalThis.fetch | undefined;
const fetchMock = vi.fn();

beforeEach(async () => {
  tempHome = await mkdtemp(join(tmpdir(), 'valis-qheal-'));
  prevValisHome = process.env.VALIS_HOME;
  prevFetch = globalThis.fetch;
  process.env.VALIS_HOME = tempHome;
  fetchMock.mockReset();
  globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
});

afterEach(async () => {
  if (prevValisHome === undefined) delete process.env.VALIS_HOME;
  else process.env.VALIS_HOME = prevValisHome;
  globalThis.fetch = prevFetch as typeof globalThis.fetch;
  await rm(tempHome, { recursive: true, force: true });
});

function mockCollectionInfo(payloadSchemaKeys: string[]) {
  const schema: Record<string, { data_type: string }> = {};
  for (const k of payloadSchemaKeys) schema[k] = { data_type: 'keyword' };
  return {
    ok: true,
    status: 200,
    json: async () => ({ result: { payload_schema: schema } }),
  } as Response;
}

describe('qdrant-self-heal — runQdrantHeal', () => {
  it('returns no_creds when QDRANT_URL/QDRANT_API_KEY missing', async () => {
    delete process.env.QDRANT_URL;
    delete process.env.QDRANT_API_KEY;
    const reports = await runQdrantHeal();
    expect(reports.length).toBe(1);
    expect(reports[0].outcome).toBe('no_creds');
  });

  it('all-fresh when collections already have every required index', async () => {
    const allFields = QDRANT_INDEXES.map((i) => i.field_name);
    fetchMock.mockResolvedValue(mockCollectionInfo(allFields));

    const reports = await runQdrantHeal({
      url: 'http://qdrant.test',
      apiKey: 'key',
      force: true,
    });
    expect(reports.length).toBe(QDRANT_COLLECTIONS.length);
    for (const r of reports) expect(r.outcome).toBe('fresh');
  });

  it('repairs missing indexes via PUT for each absent field', async () => {
    // Collection knows only org_id; the other 5 fields are missing.
    fetchMock.mockImplementation(async (_url: string, opts?: RequestInit) => {
      if (opts?.method === 'PUT') {
        return { ok: true, status: 200, json: async () => ({}) } as Response;
      }
      return mockCollectionInfo(['org_id']);
    });

    const reports = await runQdrantHeal({
      url: 'http://qdrant.test',
      apiKey: 'key',
      force: true,
    });
    const repaired = reports.filter((r) => r.outcome === 'repaired');
    expect(repaired.length).toBe(QDRANT_COLLECTIONS.length);
    for (const r of repaired) {
      expect(r.repaired_fields).toBeDefined();
      expect(r.repaired_fields!.length).toBe(5);
      expect(r.repaired_fields).toContain('decision_id');
      expect(r.repaired_fields).toContain('chunk_index');
    }
  });

  it('reports collection_absent on 404 from collection-info', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({}),
    } as Response);
    const reports = await runQdrantHeal({
      url: 'http://qdrant.test',
      apiKey: 'key',
      force: true,
    });
    for (const r of reports) expect(r.outcome).toBe('collection_absent');
  });

  it('reports unreachable on non-2xx that is not 404', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({}),
    } as Response);
    const reports = await runQdrantHeal({
      url: 'http://qdrant.test',
      apiKey: 'key',
      force: true,
    });
    for (const r of reports) expect(r.outcome).toBe('unreachable');
  });

  it('respects 24h cooldown: second run within window returns cooldown', async () => {
    fetchMock.mockResolvedValue(
      mockCollectionInfo(QDRANT_INDEXES.map((i) => i.field_name)),
    );
    const first = await runQdrantHeal({
      url: 'http://qdrant.test',
      apiKey: 'key',
    });
    expect(first.every((r) => r.outcome === 'fresh')).toBe(true);

    const second = await runQdrantHeal({
      url: 'http://qdrant.test',
      apiKey: 'key',
    });
    expect(second.length).toBe(1);
    expect(second[0].outcome).toBe('cooldown');
  });

  it('writes the watermark file after a successful run', async () => {
    fetchMock.mockResolvedValue(
      mockCollectionInfo(QDRANT_INDEXES.map((i) => i.field_name)),
    );
    await runQdrantHeal({
      url: 'http://qdrant.test',
      apiKey: 'key',
      force: true,
    });
    const watermark = JSON.parse(
      await readFile(join(tempHome, 'last-qdrant-index-check.json'), 'utf-8'),
    );
    expect(watermark.last_checked_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('force option bypasses cooldown', async () => {
    fetchMock.mockResolvedValue(
      mockCollectionInfo(QDRANT_INDEXES.map((i) => i.field_name)),
    );
    await runQdrantHeal({
      url: 'http://qdrant.test',
      apiKey: 'key',
      force: true,
    });
    const second = await runQdrantHeal({
      url: 'http://qdrant.test',
      apiKey: 'key',
      force: true,
    });
    expect(second.every((r) => r.outcome === 'fresh')).toBe(true);
  });
});
