/**
 * gh#329 — `library_search` over the read-only `sources_v1` reference corpus.
 *
 * The governing rule of this suite: a broken library must never be reportable
 * as an empty result. Every failure path is asserted to carry a named code,
 * and the read-only boundary is asserted across the whole file.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  LibraryError,
  assertLibraryConfigured,
  resolveLibraryProjectId,
  assertLibraryReadable,
  assertLibrarySchema,
  searchLibrary,
  toLibraryResult,
} from '../../src/mcp/tools/library-search.js';
import type { ServerConfig } from '../../src/types.js';

const HEALTHY_COLLECTION = {
  config: {
    params: {
      vectors: { '': { size: 384, distance: 'Cosine' } },
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
  score: 0.45,
  payload: {
    title: 'Caterpillar Performance Handbook',
    page: 124,
    identifier: 'cat-perf-48',
    lang: 'en',
    year: 2018,
    decision_id: 'work-1',
    chunk_text: 'Rolling resistance is about 10 kg/metric ton on a firm surface.',
    contextual_text: 'Table of rolling resistance factors by surface.',
  },
};

describe('LibraryError envelope', () => {
  it('carries the structured payload in the message', () => {
    const err = new LibraryError(
      'library_rebuild_required',
      'index:title',
      'The reference library needs reindexing.',
    );
    // The SDK keeps only `err.message` — it catches the throw and returns
    // createToolError(err.message) as a SUCCESSFUL result with isError:true
    // (server/mcp.js:140-158). So the message must BE the payload.
    expect(JSON.parse(err.message)).toEqual({
      error: {
        code: 'library_rebuild_required',
        missing: 'index:title',
        message: 'The reference library needs reindexing.',
      },
    });
  });

  it('exposes code and missing as instance properties', () => {
    // classifyError (analytics.ts:48-58) reads err.code off the instance.
    // A declared-but-unassigned field would emit error_code:'Error'.
    const err = new LibraryError('library_forbidden', 'project:abc', 'Not permitted.');
    expect(err.code).toBe('library_forbidden');
    expect(err.missing).toBe('project:abc');
    expect(err.name).toBe('LibraryError');
    expect(err).toBeInstanceOf(Error);
  });

  it('never produces a body containing a results key', () => {
    const err = new LibraryError('library_unavailable', 'query_failed', 'Upstream failed.');
    const body = JSON.parse(err.message) as Record<string, unknown>;
    expect(body).not.toHaveProperty('results');
  });
});

describe('library project resolution (gh#329 T5)', () => {
  const base = {
    supabase_url: 'https://x.supabase.co',
    supabase_service_role_key: 'srk',
    qdrant_url: 'https://q',
    qdrant_api_key: 'qk',
    member_id: 'member-1',
  } as unknown as ServerConfig;

  afterEach(() => {
    delete process.env.VALIS_LIBRARY_PROJECT_ID;
  });

  it('prefers the hosted ServerConfig field', () => {
    process.env.VALIS_LIBRARY_PROJECT_ID = 'from-env';
    const cfg = { ...base, library_project_id: 'from-server-config' } as ServerConfig;
    expect(resolveLibraryProjectId(cfg, { library_project_id: 'from-file' })).toBe(
      'from-server-config',
    );
  });

  it('falls back to the stdio config file', () => {
    process.env.VALIS_LIBRARY_PROJECT_ID = 'from-env';
    expect(resolveLibraryProjectId(undefined, { library_project_id: 'from-file' })).toBe(
      'from-file',
    );
  });

  it('falls back to the env var when neither config carries the field', () => {
    process.env.VALIS_LIBRARY_PROJECT_ID = 'from-env';
    expect(resolveLibraryProjectId(undefined, {})).toBe('from-env');
  });

  it('returns undefined when all three sources are absent', () => {
    expect(resolveLibraryProjectId(undefined, {})).toBeUndefined();
  });
});

describe('preflight (gh#329 T5)', () => {
  const full = {
    supabase_url: 'https://x.supabase.co',
    supabase_service_role_key: 'srk',
    qdrant_url: 'https://q',
    qdrant_api_key: 'qk',
    member_id: 'member-1',
    library_project_id: 'lib-proj',
  } as unknown as ServerConfig;

  const codeOf = (fn: () => unknown) => {
    try {
      fn();
      return null;
    } catch (err) {
      return err instanceof LibraryError ? { code: err.code, missing: err.missing } : null;
    }
  };

  it('accepts a fully configured server config', () => {
    expect(() => assertLibraryConfigured(full)).not.toThrow();
  });

  it('names library_project_id when the library is not configured', () => {
    const { library_project_id: _drop, ...rest } = full as Record<string, unknown>;
    expect(codeOf(() => assertLibraryConfigured(rest as unknown as ServerConfig))).toEqual({
      code: 'library_not_configured',
      missing: 'library_project_id',
    });
  });

  it('names qdrant_url when the cluster is not configured', () => {
    const { qdrant_url: _drop, ...rest } = full as Record<string, unknown>;
    expect(codeOf(() => assertLibraryConfigured(rest as unknown as ServerConfig))).toEqual({
      code: 'library_not_configured',
      missing: 'qdrant_url',
    });
  });

  it('names member_id when there is no caller identity', () => {
    const { member_id: _drop, ...rest } = full as Record<string, unknown>;
    expect(codeOf(() => assertLibraryConfigured(rest as unknown as ServerConfig))).toEqual({
      code: 'library_not_configured',
      missing: 'member_id',
    });
  });
});

describe('authorisation (gh#329 T6)', () => {
  const codeOf = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      return null;
    } catch (err) {
      return err instanceof LibraryError ? { code: err.code, missing: err.missing } : err;
    }
  };

  it('passes through on allow', async () => {
    await expect(
      assertLibraryReadable(async () => 'allow', 'lib-proj'),
    ).resolves.toBeUndefined();
  });

  it('reports deny as library_forbidden', async () => {
    expect(await codeOf(() => assertLibraryReadable(async () => 'deny', 'lib-proj'))).toEqual({
      code: 'library_forbidden',
      missing: 'project:lib-proj',
    });
  });

  it('reports unavailable as library_unavailable, never as a denial', async () => {
    // A Supabase outage is not an authorisation decision. Reporting it as one
    // would be the feature's own failure mode, one layer up.
    expect(
      await codeOf(() => assertLibraryReadable(async () => 'unavailable', 'lib-proj')),
    ).toEqual({ code: 'library_unavailable', missing: 'authorization' });
  });
});

describe('schema guard (gh#329 T7)', () => {
  const healthy = {
    config: {
      params: {
        vectors: { '': { size: 384, distance: 'Cosine' } },
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

  const codeOf = (info: unknown) => {
    try {
      assertLibrarySchema(info as never);
      return null;
    } catch (err) {
      return err instanceof LibraryError ? { code: err.code, missing: err.missing } : err;
    }
  };

  const without = (key: string) => {
    const clone = structuredClone(healthy) as Record<string, never>;
    delete (clone.payload_schema as Record<string, unknown>)[key];
    return clone;
  };

  it('accepts a healthy collection', () => {
    expect(codeOf(healthy)).toBeNull();
  });

  it('reports an absent collection as unavailable', () => {
    expect(codeOf(null)).toEqual({
      code: 'library_unavailable',
      missing: 'collection:sources_v1',
    });
  });

  it('fails on a missing dense vector', () => {
    const broken = structuredClone(healthy) as Record<string, never>;
    (broken.config as never as Record<string, never>).params = {
      sparse_vectors: { bm25: {} },
    } as never;
    expect(codeOf(broken)).toEqual({ code: 'library_rebuild_required', missing: 'vector:dense' });
  });

  it('fails on a wrong dense vector size', () => {
    const broken = structuredClone(healthy) as Record<string, never>;
    ((broken.config as never as Record<string, never>).params as never as Record<string, never>)
      .vectors = { '': { size: 768 } } as never;
    expect(codeOf(broken)).toEqual({ code: 'library_rebuild_required', missing: 'vector:dense' });
  });

  it('fails on a missing bm25 sparse vector', () => {
    const broken = structuredClone(healthy) as Record<string, never>;
    delete ((broken.config as never as Record<string, never>).params as never as Record<
      string,
      never
    >).sparse_vectors;
    expect(codeOf(broken)).toEqual({ code: 'library_rebuild_required', missing: 'vector:bm25' });
  });

  // Acceptance criterion 4 is unconditional: a deleted index must surface even
  // on a query that never filters on that field. This is why the guard checks
  // the full declared contract rather than only the filters in play.
  it('fails on a deleted title index regardless of the query filters', () => {
    expect(codeOf(without('title'))).toEqual({
      code: 'library_rebuild_required',
      missing: 'index:title',
    });
  });

  it('fails on a deleted project_id index', () => {
    expect(codeOf(without('project_id'))).toEqual({
      code: 'library_rebuild_required',
      missing: 'index:project_id',
    });
  });

  // Presence is not the contract — type is. A text index passes a presence
  // check while silently changing exact-match semantics.
  it('fails on a title index of the wrong data_type', () => {
    const broken = structuredClone(healthy) as Record<string, never>;
    (broken.payload_schema as Record<string, unknown>).title = { data_type: 'text' };
    expect(codeOf(broken)).toEqual({
      code: 'library_rebuild_required',
      missing: 'index:title',
    });
  });
});

function makeQdrant(hits: unknown[] = [], count = 0) {
  return {
    getCollection: vi.fn().mockResolvedValue(HEALTHY_COLLECTION),
    query: vi.fn().mockResolvedValue({ points: hits }),
    count: vi.fn().mockResolvedValue({ count }),
    // Write surface — asserted never-called by the read-only test.
    upsert: vi.fn(),
    delete: vi.fn(),
    setPayload: vi.fn(),
    createPayloadIndex: vi.fn(),
    deleteCollection: vi.fn(),
  };
}

const LIB = 'lib-proj';

describe('retrieval and scope filter (gh#329 T8)', () => {
  it('filters project_id and nothing else by default', async () => {
    const q = makeQdrant([HIT]);
    await searchLibrary(q as never, LIB, { query: 'rolling resistance' });
    const [collection, body] = q.query.mock.calls[0] as [string, Record<string, never>];
    expect(collection).toBe('sources_v1');
    expect(body.filter).toEqual({
      must: [{ key: 'project_id', match: { value: LIB } }],
    });
  });

  it('issues a dense + sparse prefetch fused with RRF', async () => {
    const q = makeQdrant([HIT]);
    await searchLibrary(q as never, LIB, { query: 'rolling resistance', k: 3 });
    const body = (q.query.mock.calls[0] as [string, Record<string, never>])[1];
    expect(body.prefetch).toEqual([
      {
        query: { text: 'rolling resistance', model: 'intfloat/multilingual-e5-small' },
        using: '',
        limit: 24,
      },
      { query: { text: 'rolling resistance', model: 'Qdrant/bm25' }, using: 'bm25', limit: 24 },
    ]);
    expect(body.query).toEqual({ fusion: 'rrf' });
    expect(body.limit).toBe(3);
    expect(body.with_payload).toBe(true);
  });

  it('maps the work filter onto the title payload key', async () => {
    const q = makeQdrant([HIT]);
    await searchLibrary(q as never, LIB, {
      query: 'x',
      filters: { work: 'Caterpillar Performance Handbook', lang: 'en' },
    });
    const body = (q.query.mock.calls[0] as [string, Record<string, never>])[1];
    expect(body.filter).toEqual({
      must: [
        { key: 'project_id', match: { value: LIB } },
        { key: 'lang', match: { value: 'en' } },
        { key: 'title', match: { value: 'Caterpillar Performance Handbook' } },
      ],
    });
  });

  it('defaults k to 5 and caps it at 20', async () => {
    const q = makeQdrant([HIT]);
    await searchLibrary(q as never, LIB, { query: 'x' });
    expect((q.query.mock.calls[0] as [string, { limit: number }])[1].limit).toBe(5);

    const q2 = makeQdrant([HIT]);
    await searchLibrary(q2 as never, LIB, { query: 'x', k: 500 });
    expect((q2.query.mock.calls[0] as [string, { limit: number }])[1].limit).toBe(20);
  });

  it('checks the collection schema on every search, uncached', async () => {
    const q = makeQdrant([HIT]);
    await searchLibrary(q as never, LIB, { query: 'x' });
    await searchLibrary(q as never, LIB, { query: 'y' });
    expect(q.getCollection).toHaveBeenCalledTimes(2);
  });

  it('rejects an empty or whitespace query before any client call', async () => {
    const q = makeQdrant([HIT]);
    await expect(searchLibrary(q as never, LIB, { query: '   ' })).rejects.toBeInstanceOf(
      LibraryError,
    );
    expect(q.query).not.toHaveBeenCalled();
  });
});

describe('verify-on-empty (gh#329 T9)', () => {
  it('reports an empty result as filter exclusion when the scope is populated', async () => {
    const q = makeQdrant([], 16344);
    const out = await searchLibrary(q as never, LIB, { query: 'x', filters: { lang: 'ja' } });
    expect(out.points).toEqual([]);
    expect(out.scopedCount).toBe(16344);
    // The count runs under the scope filter ALONE — the caller's own filters
    // are what we are testing the corpus against.
    expect((q.count.mock.calls[0] as [string, { filter: unknown }])[1].filter).toEqual({
      must: [{ key: 'project_id', match: { value: LIB } }],
    });
  });

  it('reports an empty scope as corpus:absent, never as an empty result', async () => {
    const q = makeQdrant([], 0);
    await expect(searchLibrary(q as never, LIB, { query: 'x' })).rejects.toMatchObject({
      code: 'library_rebuild_required',
      missing: 'corpus:absent',
    });
  });

  it('issues no count call when the query returned hits', async () => {
    const q = makeQdrant([HIT], 16344);
    await searchLibrary(q as never, LIB, { query: 'x' });
    expect(q.count).not.toHaveBeenCalled();
  });
});

describe('citation validation (gh#329 T10)', () => {
  const hitWithout = (key: string) => {
    const clone = structuredClone(HIT) as Record<string, never>;
    delete (clone.payload as Record<string, unknown>)[key];
    return clone;
  };

  it('maps a healthy payload to the documented shape with chunk_text verbatim', () => {
    expect(toLibraryResult([HIT])).toEqual({
      results: [
        {
          title: 'Caterpillar Performance Handbook',
          page: 124,
          identifier: 'cat-perf-48',
          lang: 'en',
          year: 2018,
          work_id: 'work-1',
          chunk_text: 'Rolling resistance is about 10 kg/metric ton on a firm surface.',
          contextual_text: 'Table of rolling resistance factors by surface.',
          score: 0.45,
        },
      ],
      dropped_uncitable: 0,
    });
  });

  it('drops an uncitable hit and reports the count rather than hiding it', () => {
    const out = toLibraryResult([HIT, hitWithout('page'), HIT]);
    expect(out.results).toHaveLength(2);
    expect(out.dropped_uncitable).toBe(1);
  });

  it('treats an all-uncitable batch as a rebuild condition, not an empty result', () => {
    // A passage with no verbatim text is the paraphrase-as-evidence failure the
    // feature exists to prevent, so it must never surface as "no evidence".
    expect(() => toLibraryResult([hitWithout('chunk_text'), hitWithout('chunk_text')])).toThrow(
      expect.objectContaining({
        code: 'library_rebuild_required',
        missing: 'payload:chunk_text',
      }) as never,
    );
  });

  it('keeps hits whose identifier and year are null', () => {
    const sparse = structuredClone(HIT) as Record<string, never>;
    (sparse.payload as Record<string, unknown>).identifier = null;
    (sparse.payload as Record<string, unknown>).year = null;
    const out = toLibraryResult([sparse]);
    expect(out.dropped_uncitable).toBe(0);
    expect(out.results[0]).toMatchObject({ identifier: null, year: null });
  });

  it('marks a filter-excluded empty result rather than returning a bare empty list', () => {
    expect(toLibraryResult([], 16344)).toEqual({
      results: [],
      dropped_uncitable: 0,
      excluded_by_filters: true,
    });
  });
});
