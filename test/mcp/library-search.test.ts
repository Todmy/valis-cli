/**
 * gh#329 — `library_search` over the read-only `sources_v1` reference corpus.
 *
 * The governing rule of this suite: a broken library must never be reportable
 * as an empty result. Every failure path is asserted to carry a named code,
 * and the read-only boundary is asserted across the whole file.
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
  LibraryError,
  assertLibraryConfigured,
  resolveLibraryProjectId,
  assertLibraryReadable,
  assertLibrarySchema,
} from '../../src/mcp/tools/library-search.js';
import type { ServerConfig } from '../../src/types.js';

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
