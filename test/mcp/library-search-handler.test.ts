/**
 * gh#329 — end-to-end coverage of `handleLibrarySearch`, the orchestrator.
 *
 * The unit tests in `library-search.test.ts` pin each piece; this file pins the
 * ORDER, which is where the security-relevant behaviour lives: an unconfigured
 * or unauthorised call must produce no cluster traffic at all, and a Qdrant 400
 * must never reach the caller as an empty list.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const qdrantMock = {
  getCollection: vi.fn(),
  query: vi.fn(),
  count: vi.fn(),
};
const resolveReadAccess = vi.fn();
const getServiceRoleSupabase = vi.fn(() => ({ brand: 'service-role' }));

vi.mock('../../src/cloud/qdrant/client.js', () => ({
  getQdrantClient: () => qdrantMock,
}));

vi.mock('../../src/lib/project-access.js', () => ({
  getServiceRoleSupabase: (...a: unknown[]) => getServiceRoleSupabase(...(a as [])),
  resolveReadAccess: (...a: unknown[]) => resolveReadAccess(...(a as [])),
}));

vi.mock('../../src/config/store.js', () => ({
  loadConfig: async () => null,
}));

import { handleLibrarySearch, LibraryError } from '../../src/mcp/tools/library-search.js';
import type { ServerConfig } from '../../src/types.js';

const HEALTHY = {
  config: {
    params: {
      vectors: { '': { size: 384 } },
      sparse_vectors: { bm25: {} },
    },
  },
  payload_schema: {
    project_id: { data_type: 'keyword' },
    lang: { data_type: 'keyword' },
    tier: { data_type: 'keyword' },
    identifier: { data_type: 'keyword' },
    title: { data_type: 'keyword' },
  },
};

const HIT = {
  score: 0.5,
  payload: {
    title: 'Caterpillar Performance Handbook',
    page: 124,
    identifier: 'cat-48',
    lang: 'en',
    year: 2018,
    decision_id: 'work-1',
    chunk_text: 'Rolling resistance is about 10 kg/metric ton.',
    contextual_text: 'Rolling resistance table.',
  },
};

const CONFIG = {
  member_id: 'member-1',
  org_id: 'org-1',
  supabase_url: 'https://x.supabase.co',
  supabase_service_role_key: 'srk',
  qdrant_url: 'https://q',
  qdrant_api_key: 'qk',
  library_project_id: 'lib-proj',
} as unknown as ServerConfig;

beforeEach(() => {
  vi.clearAllMocks();
  qdrantMock.getCollection.mockResolvedValue(HEALTHY);
  qdrantMock.query.mockResolvedValue({ points: [HIT] });
  qdrantMock.count.mockResolvedValue({ count: 16344 });
  resolveReadAccess.mockResolvedValue('allow');
});

afterEach(() => {
  delete process.env.VALIS_LIBRARY_PROJECT_ID;
});

const errOf = async (fn: () => Promise<unknown>) => {
  try {
    await fn();
    return null;
  } catch (e) {
    return e instanceof LibraryError ? { code: e.code, missing: e.missing } : e;
  }
};

describe('handleLibrarySearch — happy path', () => {
  it('returns the documented shape', async () => {
    const out = await handleLibrarySearch({ query: 'rolling resistance' }, CONFIG);
    expect(out.results).toHaveLength(1);
    expect(out.results[0]).toMatchObject({ title: 'Caterpillar Performance Handbook', page: 124 });
    expect(out.dropped_uncitable).toBe(0);
  });

  it('builds the Supabase client with the service-role key, not a JWT client', async () => {
    // An RLS-bound client returns 0 project_members rows for a legitimate
    // cross-org member — a confident false denial (the PR #56 class).
    await handleLibrarySearch({ query: 'x' }, CONFIG);
    expect(getServiceRoleSupabase).toHaveBeenCalledWith('https://x.supabase.co', 'srk');
  });

  it('authorises against the LIBRARY project, never the caller-active one', async () => {
    await handleLibrarySearch({ query: 'x' }, { ...CONFIG, project_id: 'some-other' });
    expect(resolveReadAccess).toHaveBeenCalledWith(
      expect.anything(),
      'member-1',
      'lib-proj',
    );
  });

  it('scopes the Qdrant filter to the library project alone', async () => {
    await handleLibrarySearch({ query: 'x' }, CONFIG);
    const body = qdrantMock.query.mock.calls[0][1] as { filter: unknown };
    expect(body.filter).toEqual({ must: [{ key: 'project_id', match: { value: 'lib-proj' } }] });
  });
});

describe('handleLibrarySearch — ordering guarantees', () => {
  it('issues no Qdrant call when the library is unconfigured', async () => {
    const { library_project_id: _drop, ...rest } = CONFIG as unknown as Record<string, unknown>;
    const noLibrary = rest as unknown as ServerConfig;
    expect(await errOf(() => handleLibrarySearch({ query: 'x' }, noLibrary))).toEqual({
      code: 'library_not_configured',
      missing: 'library_project_id',
    });
    expect(qdrantMock.getCollection).not.toHaveBeenCalled();
    expect(qdrantMock.query).not.toHaveBeenCalled();
  });

  it('issues no Qdrant call when access is denied', async () => {
    resolveReadAccess.mockResolvedValue('deny');
    expect(await errOf(() => handleLibrarySearch({ query: 'x' }, CONFIG))).toEqual({
      code: 'library_forbidden',
      missing: 'project:lib-proj',
    });
    expect(qdrantMock.query).not.toHaveBeenCalled();
  });

  it('reports an authorisation outage as unavailable, not as a denial', async () => {
    resolveReadAccess.mockResolvedValue('unavailable');
    expect(await errOf(() => handleLibrarySearch({ query: 'x' }, CONFIG))).toEqual({
      code: 'library_unavailable',
      missing: 'authorization',
    });
    expect(qdrantMock.query).not.toHaveBeenCalled();
  });

  it('checks the schema before querying', async () => {
    qdrantMock.getCollection.mockRejectedValue(new Error('404'));
    expect(await errOf(() => handleLibrarySearch({ query: 'x' }, CONFIG))).toEqual({
      code: 'library_unavailable',
      missing: 'collection:sources_v1',
    });
    expect(qdrantMock.query).not.toHaveBeenCalled();
  });
});

describe('handleLibrarySearch — failures never become empty results', () => {
  it('classifies an unindexed-field 400 as a rebuild condition', async () => {
    // Verified live: Qdrant answers a filter on an unindexed keyword field with
    // HTTP 400. A `catch → return []` here would say "the library knows nothing".
    qdrantMock.query.mockRejectedValue(
      new Error('Bad request: Index required but not found for "url" ...'),
    );
    expect(await errOf(() => handleLibrarySearch({ query: 'x' }, CONFIG))).toEqual({
      code: 'library_rebuild_required',
      missing: 'index:url',
    });
  });

  it('maps an unrecognised upstream failure to library_unavailable, not to []', async () => {
    qdrantMock.query.mockRejectedValue(new Error('socket hang up'));
    expect(await errOf(() => handleLibrarySearch({ query: 'x' }, CONFIG))).toEqual({
      code: 'library_unavailable',
      missing: 'query_failed',
    });
  });

  it('reports an absent corpus rather than an empty result', async () => {
    qdrantMock.query.mockResolvedValue({ points: [] });
    qdrantMock.count.mockResolvedValue({ count: 0 });
    expect(await errOf(() => handleLibrarySearch({ query: 'x' }, CONFIG))).toEqual({
      code: 'library_rebuild_required',
      missing: 'corpus:absent',
    });
  });

  it('distinguishes filter exclusion from absence', async () => {
    qdrantMock.query.mockResolvedValue({ points: [] });
    // Filter-aware counts (gh#329 R1): nothing matches `lang: ja`, but the
    // scope is populated — the caller's own filters are the reason.
    qdrantMock.count.mockImplementation(async (_n: string, body: Record<string, unknown>) => ({
      count: (body.filter as { must: unknown[] }).must.length > 1 ? 0 : 16344,
    }));
    const out = await handleLibrarySearch({ query: 'x', filters: { lang: 'ja' } }, CONFIG);
    expect(out).toEqual({ results: [], dropped_uncitable: 0, excluded_by_filters: true });
  });

  it('an unfiltered query that returns nothing over a populated corpus is a retrieval failure', async () => {
    qdrantMock.query.mockResolvedValue({ points: [] });
    expect(await errOf(() => handleLibrarySearch({ query: 'x' }, CONFIG))).toEqual({
      code: 'library_unavailable',
      missing: 'retrieval:empty',
    });
  });
});

describe('handleLibrarySearch — stdio transport', () => {
  it('resolves the library project from the env var when no ServerConfig is passed', async () => {
    process.env.VALIS_LIBRARY_PROJECT_ID = 'env-lib';
    // loadConfig is mocked to null, so the env var is the only remaining source.
    // Without it the stdio transport would advertise a tool that can only fail.
    expect(await errOf(() => handleLibrarySearch({ query: 'x' }))).toEqual({
      code: 'library_not_configured',
      missing: 'qdrant_url',
    });
  });
});
