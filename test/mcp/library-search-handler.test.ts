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
const resolveProjectOrgId = vi.fn(async () => 'org-1' as string | null);
const getServiceRoleSupabase = vi.fn(() => ({ brand: 'service-role' }));

vi.mock('../../src/cloud/qdrant/client.js', () => ({
  getQdrantClient: (...a: unknown[]) => getQdrantClient(...(a as [])),
}));

vi.mock('../../src/lib/project-access.js', () => ({
  getServiceRoleSupabase: (...a: unknown[]) => getServiceRoleSupabase(...(a as [])),
  resolveReadAccess: (...a: unknown[]) => resolveReadAccess(...(a as [])),
  resolveProjectOrgId: (...a: unknown[]) => resolveProjectOrgId(...(a as [])),
}));

const loadConfig = vi.fn(async () => null as unknown);
vi.mock('../../src/config/store.js', () => ({
  loadConfig: () => loadConfig(),
}));

const findProjectConfigPath = vi.fn(async () => null as unknown);
const findProjectMarker = vi.fn(async () => null as unknown);
const findPresentProjectMarkerPath = vi.fn(async () => null as unknown);
vi.mock('../../src/config/project.js', () => ({
  findProjectConfigPath: () => findProjectConfigPath(),
  findProjectMarker: () => findProjectMarker(),
  findPresentProjectMarkerPath: () => findPresentProjectMarkerPath(),
}));

const getQdrantClient = vi.fn(() => qdrantMock);

const storeAuditEntry = vi.fn();
vi.mock('../../src/cloud/supabase/audit.js', () => ({
  storeAuditEntry: (...a: unknown[]) => storeAuditEntry(...(a as [])),
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
  project_id: 'lib-proj',
} as unknown as ServerConfig;

beforeEach(() => {
  vi.clearAllMocks();
  qdrantMock.getCollection.mockResolvedValue(HEALTHY);
  qdrantMock.query.mockResolvedValue({ points: [HIT] });
  qdrantMock.count.mockResolvedValue({ count: 16344 });
  resolveReadAccess.mockResolvedValue('allow');
  loadConfig.mockResolvedValue(null);
  findProjectConfigPath.mockResolvedValue(null);
  findProjectMarker.mockResolvedValue(null);
  findPresentProjectMarkerPath.mockResolvedValue(null);
  resolveProjectOrgId.mockResolvedValue('org-1');
  delete process.env.CLAUDE_PROJECT_DIR;
  getQdrantClient.mockReturnValue(qdrantMock);
  // clearAllMocks clears calls, not implementations — a rejection set by one
  // test would otherwise leak into every later one.
  storeAuditEntry.mockReset();
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

  // gh#334 reversed this: the previous contract authorised against a
  // deployment-wide library project and IGNORED the caller's active project.
  // The project being read is now the unit of authorisation, whichever one it
  // is — so the assertion is that the resolved project reaches the resolver,
  // not that a fixed one does.
  it('authorises against the project whose library is being read', async () => {
    await handleLibrarySearch({ query: 'x' }, { ...CONFIG, project_id: 'some-other' });
    expect(resolveReadAccess).toHaveBeenCalledWith(
      expect.anything(),
      'member-1',
      'some-other',
    );
  });

  it('scopes the Qdrant filter to the resolved project alone', async () => {
    await handleLibrarySearch({ query: 'x' }, CONFIG);
    const body = qdrantMock.query.mock.calls[0][1] as { filter: unknown };
    expect(body.filter).toEqual({ must: [{ key: 'project_id', match: { value: 'lib-proj' } }] });
  });
});

describe('handleLibrarySearch — ordering guarantees', () => {
  it('issues no Qdrant call when the library is unconfigured', async () => {
    const { project_id: _drop, ...rest } = CONFIG as unknown as Record<string, unknown>;
    const noLibrary = rest as unknown as ServerConfig;
    expect(await errOf(() => handleLibrarySearch({ query: 'x' }, noLibrary))).toEqual({
      code: 'library_not_configured',
      missing: 'project_id',
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

  it('wraps a client-construction failure in the envelope (gh#329 R2)', async () => {
    // Building the Supabase client and resolving access happened OUTSIDE the
    // handler's try, so anything they threw reached the SDK as a plain Error —
    // no code, no `missing`, and success-shaped once a proxy drops `isError`.
    getServiceRoleSupabase.mockImplementationOnce(() => {
      throw new TypeError('Invalid URL');
    });
    expect(await errOf(() => handleLibrarySearch({ query: 'x' }, CONFIG))).toEqual({
      code: 'library_unavailable',
      missing: 'authorization',
    });
  });

  it('wraps an authorisation crash in the envelope (gh#329 R2)', async () => {
    resolveReadAccess.mockRejectedValue(new Error('supabase client exploded'));
    expect(await errOf(() => handleLibrarySearch({ query: 'x' }, CONFIG))).toEqual({
      code: 'library_unavailable',
      missing: 'authorization',
    });
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

describe('handleLibrarySearch — project scoping (gh#334)', () => {
  it("scopes the Qdrant filter to the caller's own project by default", async () => {
    await handleLibrarySearch({ query: 'x' }, { ...CONFIG, project_id: 'caller-proj' });
    const body = qdrantMock.query.mock.calls[0][1] as {
      filter: { must: Array<{ key: string; match: { value: string } }> };
    };
    expect(body.filter.must[0]).toEqual({
      key: 'project_id',
      match: { value: 'caller-proj' },
    });
  });

  // The authorisation check must run against the TARGET project, not the
  // caller's. Gating on the caller's own project would authorise every
  // cross-project read the moment the caller could read anything at all.
  it('authorises and scopes against an explicit target_project_id', async () => {
    await handleLibrarySearch(
      { query: 'x', target_project_id: 'other-proj' },
      { ...CONFIG, project_id: 'caller-proj' },
    );
    expect(resolveReadAccess.mock.calls[0][2]).toBe('other-proj');
    const body = qdrantMock.query.mock.calls[0][1] as {
      filter: { must: Array<{ key: string; match: { value: string } }> };
    };
    expect(body.filter.must[0]).toEqual({ key: 'project_id', match: { value: 'other-proj' } });
  });

  // A denied target must not fall back to the caller's own library: silently
  // answering a different question than the one asked is worse than refusing.
  it('refuses a target the caller may not read, without falling back', async () => {
    resolveReadAccess.mockResolvedValue('deny');
    expect(
      await errOf(() =>
        handleLibrarySearch(
          { query: 'x', target_project_id: 'other-proj' },
          { ...CONFIG, project_id: 'caller-proj' },
        ),
      ),
    ).toEqual({ code: 'library_forbidden', missing: 'project:other-proj' });
    expect(qdrantMock.query).not.toHaveBeenCalled();
  });

  // Feature 033 FR-015/SC-005: a project owner must be able to see who read
  // across into their project. valis_search and valis_context already emit
  // this; a library read is the same act and must not be exempt.
  it('audits a cross-project read the way valis_search does', async () => {
    await handleLibrarySearch(
      { query: 'x', target_project_id: 'other-proj' },
      { ...CONFIG, project_id: 'caller-proj' },
    );
    const entry = storeAuditEntry.mock.calls[0][1] as Record<string, unknown>;
    expect(entry).toMatchObject({
      action: 'cross_org_read',
      project_id: 'other-proj',
      target_id: 'other-proj',
      member_id: 'member-1',
      new_state: { tool: 'library_search' },
    });
  });

  it('does not audit a read of the caller\'s own library', async () => {
    await handleLibrarySearch({ query: 'x' }, { ...CONFIG, project_id: 'caller-proj' });
    expect(storeAuditEntry).not.toHaveBeenCalled();
  });

  // The audit is observability, not a gate. A failing audit backend must not
  // convert a successful, authorised read into an error.
  it('returns the results when the audit write fails', async () => {
    storeAuditEntry.mockRejectedValue(new Error('audit table down'));
    const out = await handleLibrarySearch(
      { query: 'x', target_project_id: 'other-proj' },
      { ...CONFIG, project_id: 'caller-proj' },
    );
    expect(out.results).toHaveLength(1);
  });

  it('does not audit a read it refused', async () => {
    resolveReadAccess.mockResolvedValue('deny');
    await errOf(() =>
      handleLibrarySearch(
        { query: 'x', target_project_id: 'other-proj' },
        { ...CONFIG, project_id: 'caller-proj' },
      ),
    );
    expect(storeAuditEntry).not.toHaveBeenCalled();
  });

  it('reports a missing active project as project_id, not as a deployment setting', async () => {
    expect(
      await errOf(() => handleLibrarySearch({ query: 'x' }, { ...CONFIG, project_id: null })),
    ).toEqual({ code: 'library_not_configured', missing: 'project_id' });
  });
});

/**
 * gh#334 review R1. On stdio the active project is `.valis.json` in the working
 * tree — that is what `valis init` writes and what `serve.ts:38` already reads
 * before discarding it. Resolving from the GLOBAL `~/.valis/config.json`
 * instead means a correctly initialised user is told the library is not
 * configured, or silently reads a project they switched away from.
 */
describe('handleLibrarySearch — stdio project resolution (gh#334 R1)', () => {
  const STDIO = {
    member_id: 'member-1',
    org_id: 'org-1',
    supabase_url: 'https://x.supabase.co',
    supabase_service_role_key: 'srk',
    qdrant_url: 'https://q',
    qdrant_api_key: 'qk',
  };

  it('prefers .valis.json over the global config file', async () => {
    loadConfig.mockResolvedValue({ ...STDIO, project_id: 'stale-global' });
    findProjectConfigPath.mockResolvedValue('/w/.valis.json');
    findProjectMarker.mockResolvedValue({ projectId: 'active-local' });

    await handleLibrarySearch({ query: 'x' });

    expect(resolveReadAccess.mock.calls[0][2]).toBe('active-local');
    const body = qdrantMock.query.mock.calls[0][1] as {
      filter: { must: Array<{ match: { value: string } }> };
    };
    expect(body.filter.must[0].match.value).toBe('active-local');
  });

  it('falls back to the global config when no .valis.json is present', async () => {
    loadConfig.mockResolvedValue({ ...STDIO, project_id: 'global-proj' });
    findProjectConfigPath.mockResolvedValue(null);
  findProjectMarker.mockResolvedValue(null);
  delete process.env.CLAUDE_PROJECT_DIR;
    await handleLibrarySearch({ query: 'x' });
    expect(resolveReadAccess.mock.calls[0][2]).toBe('global-proj');
  });

  // gh#334 review round 3, N1. `findProjectConfigPath` catches every readFile
  // failure — including EACCES — and keeps climbing, so an unreadable marker
  // reached this code as "no marker" and fell through to the stale global
  // project_id. A presence probe separates the two; an empty project_id is not
  // a legitimate disagreement (the schema requires a UUID), so it fails closed.
  it('refuses to fall back when a marker exists but cannot be read', async () => {
    loadConfig.mockResolvedValue({ ...STDIO, project_id: 'stale-global' });
    findProjectConfigPath.mockResolvedValue(null);
    findPresentProjectMarkerPath.mockResolvedValue('/w/.valis.json');
    findProjectMarker.mockResolvedValue(null);

    expect(await errOf(() => handleLibrarySearch({ query: 'x' }))).toEqual({
      code: 'library_not_configured',
      missing: 'valis_project_marker',
    });
    expect(qdrantMock.query).not.toHaveBeenCalled();
  });

  it('still lets an explicit target win over .valis.json', async () => {
    loadConfig.mockResolvedValue({ ...STDIO, project_id: 'global-proj' });
    findProjectConfigPath.mockResolvedValue('/w/.valis.json');
    findProjectMarker.mockResolvedValue({ projectId: 'active-local' });
    await handleLibrarySearch({ query: 'x', target_project_id: 'explicit' });
    expect(resolveReadAccess.mock.calls[0][2]).toBe('explicit');
  });

  // Reading your own active project is not a cross-org read. Comparing the
  // resolved scope against the GLOBAL config file logged every stdio call as
  // one, filling the target project's audit trail with its own owner.
  it('does not audit a read of the .valis.json project as a cross-org read', async () => {
    loadConfig.mockResolvedValue({ ...STDIO, project_id: 'stale-global' });
    findProjectConfigPath.mockResolvedValue('/w/.valis.json');
    findProjectMarker.mockResolvedValue({ projectId: 'active-local' });
    await handleLibrarySearch({ query: 'x' });
    expect(storeAuditEntry).not.toHaveBeenCalled();
  });

  it('names project_id when neither source has one', async () => {
    loadConfig.mockResolvedValue(STDIO);
    findProjectConfigPath.mockResolvedValue(null);
  findProjectMarker.mockResolvedValue(null);
  delete process.env.CLAUDE_PROJECT_DIR;
    expect(await errOf(() => handleLibrarySearch({ query: 'x' }))).toEqual({
      code: 'library_not_configured',
      missing: 'project_id',
    });
  });
});

/**
 * gh#334 review R4. `getQdrantClient` runs after authorisation has already
 * succeeded. Folding it into the `authorization` stage told an operator that
 * access verification failed when the cluster client was at fault — a wrong
 * diagnosis sends them to the wrong system.
 */
describe('handleLibrarySearch — stage classification (gh#334 R4)', () => {
  it('does not blame authorization for a Qdrant client construction failure', async () => {
    getQdrantClient.mockImplementation(() => {
      throw new Error('client init exploded');
    });
    expect(await errOf(() => handleLibrarySearch({ query: 'x' }, CONFIG))).toEqual({
      code: 'library_unavailable',
      missing: 'qdrant_client',
    });
  });

  it('still blames authorization when the resolver itself throws', async () => {
    resolveReadAccess.mockRejectedValue(new Error('supabase died'));
    expect(await errOf(() => handleLibrarySearch({ query: 'x' }, CONFIG))).toEqual({
      code: 'library_unavailable',
      missing: 'authorization',
    });
  });
});

/**
 * Round 2, N3. The per-agent endpoint REPLACES `project_id` with the forced
 * target and raises `forced_project_id` alongside it. An inequality test
 * therefore sees target == active and audits nothing, even though the read may
 * cross into another org. `valis_search` closes the same hole at
 * `search.ts:209-213`.
 */
describe('handleLibrarySearch — cross-org reads are audited by org, not by signal', () => {
  // gh#334 review round 3. Provenance used to be inferred from HOW the scope
  // arrived — an explicit target, or the per-agent endpoint's forced flag. Both
  // directions were wrong, and both are pinned below.
  it('audits a read of a project owned by another org', async () => {
    resolveProjectOrgId.mockResolvedValue('org-2');
    await handleLibrarySearch({ query: 'x', target_project_id: 'public-proj' }, CONFIG);
    const entry = storeAuditEntry.mock.calls[0][1] as Record<string, unknown>;
    expect(entry).toMatchObject({ action: 'cross_org_read', project_id: 'public-proj' });
  });

  // A local `.valis.json` can point straight at another org's public project:
  // no explicit target, no forced flag, and previously no audit row at all.
  it('audits a cross-org read that arrived with no explicit target', async () => {
    resolveProjectOrgId.mockResolvedValue('org-2');
    await handleLibrarySearch({ query: 'x' }, CONFIG);
    expect(storeAuditEntry).toHaveBeenCalledTimes(1);
  });

  // The per-agent endpoint sets `forced_project_id` unconditionally, so a
  // member reading THEIR OWN project was reported as a cross-org read.
  it('does not audit a forced scope that stays inside the caller\'s own org', async () => {
    await handleLibrarySearch(
      { query: 'x' },
      { ...CONFIG, project_id: 'forced-proj', forced_project_id: 'forced-proj' } as ServerConfig,
    );
    expect(storeAuditEntry).not.toHaveBeenCalled();
  });

  it('does not audit an ordinary read of the caller\'s own project', async () => {
    await handleLibrarySearch({ query: 'x' }, { ...CONFIG, project_id: 'own-proj' });
    expect(storeAuditEntry).not.toHaveBeenCalled();
  });

  // An audit trail that goes quiet during a database fault is the same silent
  // false absence in a new place, so an unknown org over-records.
  it('audits when the target org cannot be established', async () => {
    resolveProjectOrgId.mockResolvedValue(null);
    await handleLibrarySearch({ query: 'x' }, CONFIG);
    expect(storeAuditEntry).toHaveBeenCalledTimes(1);
  });
});
