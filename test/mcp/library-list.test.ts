/**
 * gh#334 — `library_list` states what a project's library actually holds.
 *
 * The contract under test is the same one `library_search` carries: a fault is
 * never allowed to read as "the shelf is empty". The one deliberate exception
 * is a project with no corpus attached — there, an empty shelf is the true
 * answer, and `has_library: false` says so explicitly rather than leaving the
 * caller to infer it from a zero count.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { listLibrary, type LibraryListResult } from '../../src/mcp/tools/library-list.js';
import { LibraryError, type QdrantLike } from '../../src/mcp/tools/library-search.js';

const HEALTHY = {
  config: { params: { vectors: { '': { size: 384 } }, sparse_vectors: { bm25: {} } } },
  payload_schema: {
    project_id: { data_type: 'keyword' },
    lang: { data_type: 'keyword' },
    tier: { data_type: 'keyword' },
    identifier: { data_type: 'keyword' },
    title: { data_type: 'keyword' },
  },
};

const PROJECT = 'proj-1';

function makeClient(opts: {
  total?: number;
  titles?: Array<{ value: unknown; count?: number }>;
  langs?: Array<{ value: unknown; count?: number }>;
  collection?: unknown;
  /** Points whose `title` payload key is absent — counted, not derived. */
  missingTitle?: number;
  /** Points whose `title` is present but an empty string — also counted, not faceted. */
  blankTitle?: number;
}) {
  const facet = vi.fn(async (_n: string, body: Record<string, unknown>) => ({
    hits: body.key === 'title' ? (opts.titles ?? []) : (opts.langs ?? []),
  }));
  return {
    getCollection: vi
      .fn()
      .mockResolvedValue('collection' in opts ? opts.collection : HEALTHY),
    query: vi.fn(),
    count: vi.fn(async (_n: string, body: Record<string, unknown>) => {
      const must = (body.filter as { must: Array<Record<string, unknown>> }).must;
      const isEmptyProbe = must.some((c) => 'is_empty' in c);
      if (isEmptyProbe) return { count: opts.missingTitle ?? 0 };
      const blankProbe = must.some(
        (c) =>
          c.key === 'title' && (c.match as { value?: unknown } | undefined)?.value === '',
      );
      if (blankProbe) return { count: opts.blankTitle ?? 0 };
      return { count: opts.total ?? 0 };
    }),
    facet,
  } as unknown as QdrantLike & { facet: typeof facet };
}

const errOf = async (fn: () => Promise<unknown>) => {
  try {
    await fn();
    return null;
  } catch (e) {
    return e instanceof LibraryError ? { code: e.code, missing: e.missing } : e;
  }
};

describe('listLibrary — coverage', () => {
  let result: LibraryListResult;

  beforeEach(async () => {
    const client = makeClient({
      total: 16344,
      titles: [
        { value: 'Rolling Resistance Handbook', count: 400 },
        { value: 'ISO 9001', count: 900 },
      ],
      langs: [
        { value: 'de', count: 100 },
        { value: 'en', count: 16244 },
      ],
    });
    result = await listLibrary(client, PROJECT);
  });

  it('reports the project it describes, so a result cannot be misattributed', () => {
    expect(result.project_id).toBe(PROJECT);
    expect(result.has_library).toBe(true);
    expect(result.total_passages).toBe(16344);
  });

  it('orders works by passage count, densest first', () => {
    expect(result.works).toEqual([
      { title: 'ISO 9001', passages: 900 },
      { title: 'Rolling Resistance Handbook', passages: 400 },
    ]);
  });

  it('reports languages sorted, without their counts', () => {
    expect(result.languages).toEqual(['de', 'en']);
  });

  it('does not claim truncation when the shelf fits', () => {
    expect(result.truncated).toBeUndefined();
  });
});

describe('listLibrary — scoping', () => {
  it('facets under the project scope filter, never the whole collection', async () => {
    const client = makeClient({ total: 5, titles: [{ value: 'A', count: 5 }] });
    await listLibrary(client, PROJECT);
    const body = client.facet.mock.calls[0][1] as { filter: unknown; key: string };
    expect(body.key).toBe('title');
    expect(body.filter).toEqual({ must: [{ key: 'project_id', match: { value: PROJECT } }] });
  });
});

describe('listLibrary — empty is not the same as broken', () => {
  it('reports has_library false for a project with no corpus attached', async () => {
    const client = makeClient({ total: 0 });
    const out = await listLibrary(client, PROJECT);
    expect(out).toEqual({
      project_id: PROJECT,
      has_library: false,
      total_passages: 0,
      works: [],
      languages: [],
      untitled_passages: 0,
    });
  });

  it('does not facet at all when the scope is empty', async () => {
    const client = makeClient({ total: 0 });
    await listLibrary(client, PROJECT);
    expect(client.facet).not.toHaveBeenCalled();
  });

  // A populated scope whose points carry no title cannot be cited from. Calling
  // that a healthy library would promise citations the corpus cannot honour.
  it('treats a populated scope with no usable titles as a rebuild condition', async () => {
    const client = makeClient({ total: 900, titles: [] });
    expect(await errOf(() => listLibrary(client, PROJECT))).toEqual({
      code: 'library_rebuild_required',
      missing: 'payload:title',
    });
  });

  // gh#334 review R3: this used to assert only that bad buckets were dropped —
  // pinning the defect, not the guarantee. Dropping them is correct; doing so
  // WITHOUT telling the caller is the silent-partial-truth version of the
  // failure this feature exists to prevent. The count is the guarantee.
  it('reports the passages no listed work accounts for, instead of hiding them', async () => {
    const client = makeClient({
      total: 900,
      missingTitle: 0,
      blankTitle: 1,
      titles: [
        { value: '', count: 1 },
        { value: '  ', count: 2 },
        { value: 42, count: 3 },
        { value: 'Real Work', count: 894 },
      ],
    });
    const out = await listLibrary(client, PROJECT);
    expect(out.works).toEqual([{ title: 'Real Work', passages: 894 }]);
    expect(out.untitled_passages).toBe(6);
    expect(out.total_passages).toBe(900);
  });

  // The dominant damage class is points with NO title key at all. Deriving the
  // figure from total-minus-accounted made it invisible under truncation and
  // meaningless under concurrent ingest; it is counted directly now.
  it('counts points with no title key via an exact is_empty probe', async () => {
    const client = makeClient({
      total: 1000,
      missingTitle: 40,
      titles: [{ value: 'A', count: 960 }],
    });
    const out = await listLibrary(client, PROJECT);
    expect(out.untitled_passages).toBe(40);
  });

  it('reports zero unaccounted passages for an intact shelf', async () => {
    const client = makeClient({
      total: 900,
      titles: [{ value: 'A', count: 500 }, { value: 'B', count: 400 }],
    });
    expect((await listLibrary(client, PROJECT)).untitled_passages).toBe(0);
  });

  // Concurrent ingest between the count and the facet used to make the old
  // subtraction meaningless, clamped to zero by Math.max. An exact probe is
  // independent of both round trips.
  it('is unaffected when facet counts exceed the earlier scope count', async () => {
    const client = makeClient({
      total: 100,
      missingTitle: 0,
      titles: [{ value: 'A', count: 150 }],
    });
    expect((await listLibrary(client, PROJECT)).untitled_passages).toBe(0);
  });
});

describe('listLibrary — schema guard runs first', () => {
  it('names a missing collection before counting anything', async () => {
    const client = makeClient({ collection: null });
    expect(await errOf(() => listLibrary(client, PROJECT))).toEqual({
      code: 'library_unavailable',
      missing: 'collection:sources_v1',
    });
    expect(client.count).not.toHaveBeenCalled();
  });

  // A facet on an unindexed keyword field is an HTTP 400, not a silent zero.
  // Without this guard a dropped index would surface as an empty shelf.
  it('names a dropped title index instead of reporting an empty shelf', async () => {
    const broken = structuredClone(HEALTHY);
    delete (broken.payload_schema as Record<string, unknown>).title;
    const client = makeClient({ collection: broken, total: 900 });
    expect(await errOf(() => listLibrary(client, PROJECT))).toEqual({
      code: 'library_rebuild_required',
      missing: 'index:title',
    });
  });
});

describe('listLibrary — truncation is stated, never silent', () => {
  it('caps the shelf at 200 works and says so', async () => {
    const titles = Array.from({ length: 201 }, (_, i) => ({ value: `Work ${i}`, count: 201 - i }));
    const client = makeClient({ total: 20000, titles });
    const out = await listLibrary(client, PROJECT);
    expect(out.works).toHaveLength(200);
    expect(out.truncated).toBe(true);
    // A large healthy shelf must not be reported as damaged just because works
    // did not fit — the shortfall from truncation is not corruption.
    expect(out.untitled_passages).toBe(0);
  });

  // gh#334 review round 2, N2: the previous version suppressed the damage
  // figure whenever the shelf truncated, so the largest libraries were exactly
  // the ones whose corruption stayed invisible.
  it('still reports damage on a truncated shelf', async () => {
    const titles = Array.from({ length: 250 }, (_, i) => ({ value: `Work ${i}`, count: 4 }));
    const client = makeClient({ total: 1040, missingTitle: 40, titles });
    const out = await listLibrary(client, PROJECT);
    expect(out.truncated).toBe(true);
    expect(out.untitled_passages).toBe(40);
  });

  // gh#334 review round 3, N2: blank titles were only ever seen as a facet
  // bucket, and a bucket beyond the ceiling is never returned — so the largest
  // shelves reported zero damage while carrying a whole uncitable population.
  // An exact count is independent of the ceiling.
  it('counts blank titles on a truncated shelf, where no bucket for them is returned', async () => {
    const titles = Array.from({ length: 250 }, (_, i) => ({ value: `Work ${i}`, count: 4 }));
    const client = makeClient({ total: 1070, missingTitle: 0, blankTitle: 70, titles });
    const out = await listLibrary(client, PROJECT);
    expect(out.truncated).toBe(true);
    expect(out.untitled_passages).toBe(70);
  });

  it('requests one over the cap, which is how truncation is detected', async () => {
    const client = makeClient({ total: 5, titles: [{ value: 'A', count: 5 }] });
    await listLibrary(client, PROJECT);
    expect((client.facet.mock.calls[0][1] as { limit: number }).limit).toBe(201);
  });
});
