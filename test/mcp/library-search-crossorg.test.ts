/**
 * gh#329 (verify V4) — the cross-org public read, end to end.
 *
 * `library-search-handler.test.ts` mocks `resolveReadAccess`, and
 * `test/lib/project-access.test.ts` tests the resolver in isolation. Both sides
 * were pinned; their composition was not. This file runs the REAL resolver
 * against a mocked Supabase, through the real handler.
 *
 * The scenario that matters: a caller who is NOT a member of the library
 * project reads it because the project is `visibility = 'public'`. That is the
 * whole delivery mechanic of the reference library — every consumer is
 * out-of-org by construction. If the membership check ever shadowed the public
 * short-circuit, every user would get `library_forbidden` and the feature would
 * be dead on arrival while both unit suites stayed green.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const qdrantMock = {
  getCollection: vi.fn(),
  query: vi.fn(),
  count: vi.fn(),
};

/** Rows the fake Supabase answers with, rewritten per test. */
const db = {
  project: { data: null as unknown, error: null as unknown },
  membership: { count: 0, error: null as unknown },
};

/** Minimal chainable stub: every builder method returns `this` and the chain is thenable. */
function makeSupabase() {
  const builder = (result: unknown) => {
    const chain: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'limit', 'order']) chain[m] = () => chain;
    chain.maybeSingle = async () => result;
    chain.then = (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve);
    return chain;
  };
  return {
    from: (table: string) =>
      builder(table === 'projects' ? db.project : db.membership),
  };
}

vi.mock('../../src/cloud/qdrant/client.js', () => ({
  getQdrantClient: () => qdrantMock,
}));

vi.mock('../../src/lib/project-access.js', async (importOriginal) => ({
  // resolveReadAccess stays REAL — that is the point of this file.
  ...(await importOriginal<Record<string, unknown>>()),
  getServiceRoleSupabase: () => makeSupabase(),
}));

vi.mock('../../src/config/store.js', () => ({ loadConfig: async () => null }));

import { handleLibrarySearch, LibraryError } from '../../src/mcp/tools/library-search.js';
import type { ServerConfig } from '../../src/types.js';

const HEALTHY = {
  config: { params: { vectors: { '': { size: 384 } }, sparse_vectors: { bm25: {} } } },
  payload_schema: Object.fromEntries(
    ['project_id', 'lang', 'tier', 'identifier', 'title'].map((f) => [f, { data_type: 'keyword' }]),
  ),
};

const HIT = {
  score: 0.5,
  payload: {
    title: 'Caterpillar Performance Handbook',
    page: 124,
    identifier: 'cat-48',
    lang: 'en',
    chunk_text: 'Rolling resistance is about 10 kg/metric ton.',
  },
};

const CONFIG = {
  member_id: 'outsider-member',
  org_id: 'some-other-org',
  supabase_url: 'https://x.supabase.co',
  supabase_service_role_key: 'srk',
  qdrant_url: 'https://q',
  qdrant_api_key: 'qk',
  project_id: 'lib-proj',
} as unknown as ServerConfig;

beforeEach(() => {
  vi.clearAllMocks();
  qdrantMock.getCollection.mockResolvedValue(HEALTHY);
  qdrantMock.query.mockResolvedValue({ points: [HIT] });
  qdrantMock.count.mockResolvedValue({ count: 16344 });
  db.project = { data: { id: 'lib-proj', visibility: 'public' }, error: null };
  db.membership = { count: 0, error: null };
});

const codeOf = async (fn: () => Promise<unknown>) => {
  try {
    await fn();
    return 'ok';
  } catch (e) {
    return e instanceof LibraryError ? `${e.code}/${e.missing}` : String(e);
  }
};

describe('cross-org public read, end to end (gh#329 V4)', () => {
  it('a non-member reads a public library', async () => {
    const out = await handleLibrarySearch({ query: 'rolling resistance' }, CONFIG);
    expect(out.results).toHaveLength(1);
    expect(out.results[0].page).toBe(124);
  });

  it('a non-member is refused when the same library is private', async () => {
    db.project = { data: { id: 'lib-proj', visibility: 'private' }, error: null };
    expect(await codeOf(() => handleLibrarySearch({ query: 'x' }, CONFIG))).toBe(
      'library_forbidden/project:lib-proj',
    );
  });

  it('a member reads a private library', async () => {
    db.project = { data: { id: 'lib-proj', visibility: 'private' }, error: null };
    db.membership = { count: 1, error: null };
    const out = await handleLibrarySearch({ query: 'x' }, CONFIG);
    expect(out.results).toHaveLength(1);
  });

  it('a non-existent library project is an authoritative denial, not an outage', async () => {
    db.project = { data: null, error: null };
    expect(await codeOf(() => handleLibrarySearch({ query: 'x' }, CONFIG))).toBe(
      'library_forbidden/project:lib-proj',
    );
  });

  it('a Supabase outage is reported as unavailable, never as a denial', async () => {
    db.project = { data: null, error: { message: 'connection refused' } };
    expect(await codeOf(() => handleLibrarySearch({ query: 'x' }, CONFIG))).toBe(
      'library_unavailable/authorization',
    );
  });

  it('a membership-query outage on a private project is unavailable, not a denial', async () => {
    db.project = { data: { id: 'lib-proj', visibility: 'private' }, error: null };
    db.membership = { count: 0, error: { message: 'statement timeout' } };
    expect(await codeOf(() => handleLibrarySearch({ query: 'x' }, CONFIG))).toBe(
      'library_unavailable/authorization',
    );
  });
});
