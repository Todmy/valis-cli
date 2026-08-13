/**
 * gh#329 (review R1) — the three causes of zero hits must not be conflated.
 *
 * The original verify-on-empty counted under the SCOPE filter alone. That
 * answers "is the corpus there", which is the wrong question when the caller
 * supplied no filters: a broken retrieval path over a healthy corpus produced
 * `{results: [], excluded_by_filters: true}` — a success-shaped empty result
 * blaming filters the caller never sent. That is precisely the silent false
 * absence this feature exists to prevent.
 *
 * Counting under the FULL active filter separates them:
 *   matching > 0, retrieval returned none  → retrieval is broken
 *   matching = 0, scope > 0                → the caller's filters excluded it
 *   matching = 0, scope = 0                → the corpus is absent
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { searchLibrary, LibraryError, SOURCES_COLLECTION } from '../../src/mcp/tools/library-search.js';

const HEALTHY = {
  config: { params: { vectors: { '': { size: 384 } }, sparse_vectors: { bm25: {} } } },
  payload_schema: Object.fromEntries(
    ['project_id', 'lang', 'tier', 'identifier', 'title'].map((f) => [f, { data_type: 'keyword' }]),
  ),
};

const LIB = 'lib-proj';

/** Counts keyed by how many `must` clauses the filter carries. */
function makeClient(counts: { full: number; scopeOnly: number }) {
  const countCalls: Array<Record<string, unknown>> = [];
  return {
    countCalls,
    getCollection: vi.fn().mockResolvedValue(HEALTHY),
    query: vi.fn().mockResolvedValue({ points: [] }),
    count: vi.fn(async (_name: string, body: Record<string, unknown>) => {
      countCalls.push(body);
      const must = (body.filter as { must: unknown[] }).must;
      return { count: must.length > 1 ? counts.full : counts.scopeOnly };
    }),
  };
}

const search = (client: unknown, args: Record<string, unknown>) =>
  searchLibrary(client as never, LIB, args as never);

const codeOf = async (fn: () => Promise<unknown>) => {
  try {
    await fn();
    return 'ok';
  } catch (e) {
    return e instanceof LibraryError ? `${e.code}/${e.missing}` : String(e);
  }
};

beforeEach(() => vi.clearAllMocks());

describe('zero-hit classification (gh#329 R1)', () => {
  it('an unfiltered query over a healthy corpus that returns nothing is a retrieval failure', async () => {
    // The regression. Before the fix this returned `excluded_by_filters: true`
    // with no filters in play — a broken index or a dead inference endpoint
    // reported to the agent as "the library holds no evidence".
    const client = makeClient({ full: 16344, scopeOnly: 16344 });
    expect(await codeOf(() => search(client, { query: 'rolling resistance' }))).toBe(
      'library_unavailable/retrieval:empty',
    );
  });

  it('is a retrieval failure with filters too, when points match those filters', async () => {
    const client = makeClient({ full: 42, scopeOnly: 16344 });
    expect(
      await codeOf(() => search(client, { query: 'x', filters: { lang: 'en' } })),
    ).toBe('library_unavailable/retrieval:empty');
  });

  it('reports filter exclusion only when the filters really match nothing', async () => {
    const client = makeClient({ full: 0, scopeOnly: 16344 });
    const out = await search(client, { query: 'x', filters: { lang: 'ja' } });
    expect(out.points).toEqual([]);
    expect(out.scopedCount).toBe(16344);
  });

  it('reports an absent corpus when nothing matches the scope either', async () => {
    const client = makeClient({ full: 0, scopeOnly: 0 });
    expect(
      await codeOf(() => search(client, { query: 'x', filters: { lang: 'ja' } })),
    ).toBe('library_rebuild_required/corpus:absent');
  });

  it('spends one count, not two, when the caller sent no filters', async () => {
    // With no filters the full filter IS the scope filter, so a second count
    // would ask the same question twice on every empty-corpus call.
    const client = makeClient({ full: 0, scopeOnly: 0 });
    expect(await codeOf(() => search(client, { query: 'x' }))).toBe(
      'library_rebuild_required/corpus:absent',
    );
    expect(client.count).toHaveBeenCalledTimes(1);
  });

  it('counts under the caller filters, not under the scope alone', async () => {
    const client = makeClient({ full: 0, scopeOnly: 16344 });
    await search(client, { query: 'x', filters: { work: 'Caterpillar Performance Handbook' } });
    const first = client.countCalls[0] as { filter: { must: Array<{ key: string }> } };
    expect(first.filter.must.map((m) => m.key)).toEqual(['project_id', 'title']);
    expect(client.count).toHaveBeenCalledWith(SOURCES_COLLECTION, expect.objectContaining({ exact: true }));
  });
});
