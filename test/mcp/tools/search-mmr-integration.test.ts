/**
 * INTEGRATION test for MMR diversity on the FULL production read-path
 * (037-search-mmr-diversity, GitHub issue #120; PR #228 review finding 2).
 *
 * This is deliberately NOT a unit test of `mmrRerank` in isolation. It feeds
 * near-duplicate decisions through the entire `handleSearch` pipeline:
 *
 *   fake Qdrant `.query()` → real hybridSearch (map + dedupByDecisionId)
 *     → real direct transport (rankByStatus + enrichRow)
 *       → real rerank (multi-signal composite_score)
 *         → real suppressResults
 *           → real mmrRerank (FINAL transform, at the display limit)
 *
 * The ONLY mocked boundary is the Qdrant network client and the local config
 * loaders. Everything between the wire and the agent-visible response is the
 * real production code. This is the regression guard the headline SC-001 claim
 * lacked: before the fix, MMR ran mid-pipeline and was discarded by the
 * downstream re-sort, so the diversified ordering never reached the caller.
 */

import { describe, it, expect, vi, beforeAll } from 'vitest';

// Force the server (hybrid RRF) embedding strategy so hybridSearch takes the
// `qdrant.query` prefetch branch and never issues the detection probe.
beforeAll(() => {
  process.env.QDRANT_EMBEDDING_STRATEGY = 'server';
});

// ---------------------------------------------------------------------------
// Fixture design (the subtle part — read before editing):
//
// The downstream `suppressResults` pass ALSO removes same-area redundancy
// (keeps top-2 per `affects` area). To prove MMR — and not suppression — is
// what diversifies the agent-visible ORDER, the fixture must be one where
// suppression keeps every row visible, yet a pure relevance ordering still
// clusters the two near-duplicates consecutively at the very top.
//
// `dup-A` and `dup-B` share the exact same tag set (`['jwt','auth']`) →
// MMR's Jaccard sees sim = 1.0 between them. But their area has only two
// members, so suppression's "keep top-2 per area" rule leaves BOTH visible.
// The distinct facets (`rls`, `db`) are ranked just below.
//
//   pre-MMR  (relevance order): dup-A, dup-B, div-rls, div-db
//   post-MMR (k=3, λ=0.5)     : dup-A, div-rls, div-db   ← dup-B demoted out
//
// So at limit=3 the buggy mid-pipeline-MMR build (where the consumer's
// rerank re-sorts by composite_score and discards the interleaving) returns
// [dup-A, dup-B, div-rls]; the fixed build returns [dup-A, div-rls, div-db].
//
// Each row is shaped as a Qdrant point payload so `mapPointToSearchResult`
// (real code) builds the SearchResult, exactly as in production.
// ---------------------------------------------------------------------------

function point(
  id: string,
  score: number,
  affects: string[],
  summary: string,
) {
  return {
    id,
    score,
    payload: {
      decision_id: id,
      type: 'decision',
      summary,
      detail: summary,
      author: 'tester',
      affects,
      created_at: '2026-05-20T00:00:00Z',
      status: 'active',
      confidence: 0.5,
      pinned: false,
      project_id: 'project-A',
      chunk_index: 0,
      total_chunks: 1,
    },
  };
}

const NEAR_DUP_POOL = [
  point('dup-A', 0.99, ['jwt', 'auth'], 'Use JWT for auth'),
  point('dup-B', 0.98, ['jwt', 'auth'], 'JWT signing with jose'),
  point('div-rls', 0.85, ['rls'], 'Row-level security on decisions'),
  point('div-db', 0.80, ['postgres'], 'Postgres as source of truth'),
];

// Fake QdrantClient whose `.query()` returns the near-dup pool. `hybridSearch`
// over-fetches (limit*4) and dedups; our pool is small so all rows come back.
const fakeQdrant = {
  query: vi.fn().mockResolvedValue({ points: NEAR_DUP_POOL }),
};

vi.mock('../../../src/config/store.js', () => ({
  loadConfig: vi.fn().mockResolvedValue({
    org_id: 'test-org-id',
    qdrant_url: 'https://test.qdrant.io',
    qdrant_api_key: 'test-key',
    supabase_url: 'https://test.supabase.co',
    supabase_service_role_key: 'srv-key',
  }),
}));

vi.mock('../../../src/config/project.js', () => ({
  resolveConfig: vi.fn().mockResolvedValue({ project: { project_id: 'project-A' } }),
}));

vi.mock('../../../src/billing/usage.js', () => ({
  incrementUsage: vi.fn().mockResolvedValue(undefined),
  checkUsageBeforeSearch: vi.fn().mockResolvedValue({ allowed: true }),
}));

// IMPORTANT: do NOT mock '../../../src/cloud/qdrant.js' wholesale — we want the
// REAL hybridSearch / mmrRerank. Only replace the network client factory so the
// real hybridSearch talks to our fake `.query()`.
vi.mock('../../../src/cloud/qdrant/client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/cloud/qdrant/client.js')>();
  return {
    ...actual,
    getQdrantClient: vi.fn(() => fakeQdrant),
  };
});

import { handleSearch } from '../../../src/mcp/tools/search.js';

function distinctTags(results: { affects?: string[] }[]): Set<string> {
  const tags = new Set<string>();
  for (const r of results) for (const t of r.affects ?? []) tags.add(t);
  return tags;
}

describe('handleSearch — MMR diversity survives the full pipeline (SC-001, finding 2)', () => {
  it('demotes the near-duplicate out of the visible top-K (the regression guard)', async () => {
    const result = await handleSearch({ query: 'jwt auth', project_id: 'project-A', limit: 3 });
    const ids = result.results.map((r) => r.id);

    // The decisive assertion: with MMR as the FINAL transform, the second
    // near-duplicate (dup-B, Jaccard 1.0 with dup-A) is pushed out of the
    // visible top-3 in favour of a distinct facet. The buggy build (MMR
    // mid-pipeline, then re-sorted away) keeps dup-B at rank 2.
    expect(ids).not.toContain('dup-B');
    expect(ids).toEqual(['dup-A', 'div-rls', 'div-db']);
  });

  it('top-K covers >=3 distinct affects[] tags (SC-001)', async () => {
    const result = await handleSearch({ query: 'jwt auth', project_id: 'project-A', limit: 3 });
    // dup-A contributes jwt+auth, div-rls contributes rls, div-db contributes
    // postgres → >=3 distinct tags. The clustered pre-fix top-3 (dup-A, dup-B,
    // div-rls) would only span jwt+auth+rls.
    expect(distinctTags(result.results).size).toBeGreaterThanOrEqual(3);
  });

  it('keeps the single strongest hit first (relevance never sacrificed, FR-004)', async () => {
    const result = await handleSearch({ query: 'jwt auth', project_id: 'project-A', limit: 3 });
    expect(result.results[0].id).toBe('dup-A');
  });
});
