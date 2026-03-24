/**
 * Golden test harness for multi-signal reranking evaluation.
 *
 * Scaffolds 50 query-result pairs with expected orderings.
 * Actual test data will be added during the reranking phase.
 *
 * Measures NDCG@10 (Normalized Discounted Cumulative Gain) to
 * quantify ranking quality against a human-curated baseline.
 *
 * @module search/golden-test
 * @phase 003-search-growth (T010)
 */

import type { SearchResult, RerankedResult } from '../types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GoldenPair {
  /** Unique identifier for this test case. */
  id: string;
  /** The search query. */
  query: string;
  /** Simulated raw search results (in Qdrant order). */
  results: SearchResult[];
  /** Expected ordering: array of result IDs from most to least relevant. */
  expected_order: string[];
  /** Optional: tags for categorizing test cases. */
  tags?: string[];
}

export interface GoldenTestResult {
  /** The test case ID. */
  pair_id: string;
  /** NDCG@10 score (0.0 = worst, 1.0 = perfect). */
  ndcg_at_10: number;
  /** Whether actual order matches expected within tolerance. */
  passed: boolean;
  /** Actual order of result IDs after reranking. */
  actual_order: string[];
  /** Expected order of result IDs. */
  expected_order: string[];
}

export interface GoldenSuiteResult {
  /** Total number of test pairs evaluated. */
  total: number;
  /** Number of pairs that passed (NDCG@10 >= threshold). */
  passed: number;
  /** Number of pairs that failed. */
  failed: number;
  /** Average NDCG@10 across all pairs. */
  average_ndcg: number;
  /** Individual pair results. */
  details: GoldenTestResult[];
}

// ---------------------------------------------------------------------------
// NDCG@K computation
// ---------------------------------------------------------------------------

/**
 * Compute DCG (Discounted Cumulative Gain) for a list of relevance scores.
 *
 * DCG = sum of (relevance_i / log2(i + 2)) for i = 0..k-1
 *
 * @param relevances  Array of relevance scores in ranked order.
 * @param k  Number of positions to consider.
 */
export function dcg(relevances: number[], k: number): number {
  let score = 0;
  const limit = Math.min(relevances.length, k);
  for (let i = 0; i < limit; i++) {
    score += relevances[i] / Math.log2(i + 2);
  }
  return score;
}

/**
 * Compute NDCG@K (Normalized Discounted Cumulative Gain).
 *
 * NDCG = DCG(actual) / DCG(ideal)
 *
 * Relevance is assigned by position in the expected ordering:
 * - Position 0 gets the highest relevance (n), position 1 gets (n-1), etc.
 * - Items not in expected_order get relevance 0.
 *
 * @param actualOrder  Array of result IDs in actual ranked order.
 * @param expectedOrder  Array of result IDs in ideal order.
 * @param k  Number of positions to evaluate (default 10).
 * @returns NDCG@K score in [0.0, 1.0].
 */
export function ndcgAtK(
  actualOrder: string[],
  expectedOrder: string[],
  k = 10,
): number {
  // Build relevance map: expected_order[0] gets highest relevance
  const relevanceMap = new Map<string, number>();
  for (let i = 0; i < expectedOrder.length; i++) {
    relevanceMap.set(expectedOrder[i], expectedOrder.length - i);
  }

  // Compute actual relevances in ranked order
  const actualRelevances = actualOrder.map((id) => relevanceMap.get(id) ?? 0);

  // Compute ideal relevances (sorted descending)
  const idealRelevances = [...actualRelevances].sort((a, b) => b - a);

  const idealDcg = dcg(idealRelevances, k);
  if (idealDcg === 0) return 0;

  return dcg(actualRelevances, k) / idealDcg;
}

// ---------------------------------------------------------------------------
// Golden test pairs (scaffold — actual data added in reranking phase)
// ---------------------------------------------------------------------------

/**
 * Placeholder golden test pairs.
 *
 * Each pair defines a query, simulated raw results, and expected ordering.
 * The scaffold provides 5 representative pairs to validate the harness.
 * The full 50-pair set will be populated during T078 (Phase 13).
 */
export function getGoldenPairs(): GoldenPair[] {
  const now = Date.now();
  const day = 86_400_000;

  return [
    {
      id: 'golden-001',
      query: 'authentication strategy',
      tags: ['recency', 'importance'],
      expected_order: ['d1', 'd2', 'd3'],
      results: [
        makeResult('d1', {
          score: 0.85,
          summary: 'JWT-based auth for API gateway',
          affects: ['auth', 'api'],
          created_at: new Date(now - 10 * day).toISOString(),
          confidence: 0.9,
          pinned: false,
        }),
        makeResult('d2', {
          score: 0.90,
          summary: 'OAuth2 integration for third-party auth',
          affects: ['auth'],
          created_at: new Date(now - 60 * day).toISOString(),
          confidence: 0.7,
          pinned: false,
        }),
        makeResult('d3', {
          score: 0.88,
          summary: 'Session-based auth deprecated',
          affects: ['auth'],
          created_at: new Date(now - 180 * day).toISOString(),
          confidence: 0.5,
          pinned: false,
          status: 'deprecated',
        }),
      ],
    },
    {
      id: 'golden-002',
      query: 'database migration',
      tags: ['pinned', 'graph'],
      expected_order: ['d4', 'd5', 'd6'],
      results: [
        makeResult('d4', {
          score: 0.75,
          summary: 'Postgres as primary database',
          affects: ['database'],
          created_at: new Date(now - 200 * day).toISOString(),
          confidence: 0.95,
          pinned: true,
        }),
        makeResult('d5', {
          score: 0.82,
          summary: 'Migration to Postgres 16',
          affects: ['database', 'infrastructure'],
          created_at: new Date(now - 5 * day).toISOString(),
          confidence: 0.8,
          pinned: false,
          depends_on: ['d4'],
        }),
        makeResult('d6', {
          score: 0.80,
          summary: 'MySQL migration plan abandoned',
          affects: ['database'],
          created_at: new Date(now - 30 * day).toISOString(),
          confidence: 0.4,
          pinned: false,
          status: 'deprecated',
        }),
      ],
    },
    {
      id: 'golden-003',
      query: 'API versioning',
      tags: ['semantic', 'bm25'],
      expected_order: ['d7', 'd8', 'd9'],
      results: [
        makeResult('d7', {
          score: 0.92,
          summary: 'URL-based API versioning (v1/v2)',
          affects: ['api'],
          created_at: new Date(now - 20 * day).toISOString(),
          confidence: 0.85,
          pinned: false,
          bm25_score: 12.5,
        }),
        makeResult('d8', {
          score: 0.88,
          summary: 'Header-based API versioning considered',
          affects: ['api'],
          created_at: new Date(now - 25 * day).toISOString(),
          confidence: 0.6,
          pinned: false,
          bm25_score: 8.2,
        }),
        makeResult('d9', {
          score: 0.70,
          summary: 'GraphQL as alternative to REST versioning',
          affects: ['api', 'frontend'],
          created_at: new Date(now - 15 * day).toISOString(),
          confidence: 0.5,
          pinned: false,
          bm25_score: 3.1,
        }),
      ],
    },
    {
      id: 'golden-004',
      query: 'deployment strategy',
      tags: ['recency', 'suppression'],
      expected_order: ['d10', 'd11', 'd12', 'd13'],
      results: [
        makeResult('d10', {
          score: 0.86,
          summary: 'Blue-green deployment via Kubernetes',
          affects: ['deployment', 'infrastructure'],
          created_at: new Date(now - 3 * day).toISOString(),
          confidence: 0.9,
          pinned: false,
        }),
        makeResult('d11', {
          score: 0.84,
          summary: 'Canary deployments for critical services',
          affects: ['deployment'],
          created_at: new Date(now - 7 * day).toISOString(),
          confidence: 0.85,
          pinned: false,
        }),
        makeResult('d12', {
          score: 0.83,
          summary: 'Rolling deployment as default',
          affects: ['deployment'],
          created_at: new Date(now - 14 * day).toISOString(),
          confidence: 0.7,
          pinned: false,
        }),
        makeResult('d13', {
          score: 0.60,
          summary: 'Manual deployment deprecated',
          affects: ['deployment'],
          created_at: new Date(now - 100 * day).toISOString(),
          confidence: 0.3,
          pinned: false,
          status: 'deprecated',
        }),
      ],
    },
    {
      id: 'golden-005',
      query: 'error handling pattern',
      tags: ['cross-area', 'graph'],
      expected_order: ['d14', 'd15', 'd16'],
      results: [
        makeResult('d14', {
          score: 0.89,
          summary: 'Result type pattern for error handling',
          affects: ['api', 'backend'],
          created_at: new Date(now - 12 * day).toISOString(),
          confidence: 0.88,
          pinned: false,
        }),
        makeResult('d15', {
          score: 0.87,
          summary: 'Centralized error codes registry',
          affects: ['api', 'frontend', 'backend'],
          created_at: new Date(now - 18 * day).toISOString(),
          confidence: 0.82,
          pinned: false,
          depends_on: ['d14'],
        }),
        makeResult('d16', {
          score: 0.72,
          summary: 'Try-catch everywhere anti-pattern',
          affects: ['backend'],
          created_at: new Date(now - 90 * day).toISOString(),
          confidence: 0.4,
          pinned: false,
          status: 'deprecated',
        }),
      ],
    },
  ];

  // TODO: Add remaining 45 pairs during T078 (Phase 13)
}

// ---------------------------------------------------------------------------
// Test runner
// ---------------------------------------------------------------------------

/**
 * Run the golden test suite against a reranker function.
 *
 * @param rerankFn  The reranker to evaluate (typically `rerank` from reranker.ts).
 * @param threshold  Minimum NDCG@10 to pass (default 0.7).
 * @returns Suite-level results with per-pair details.
 */
export function runGoldenTests(
  rerankFn: (results: SearchResult[]) => RerankedResult[],
  threshold = 0.7,
): GoldenSuiteResult {
  const pairs = getGoldenPairs();
  const details: GoldenTestResult[] = [];

  for (const pair of pairs) {
    const reranked = rerankFn(pair.results);
    const actualOrder = reranked.map((r) => r.id);
    const ndcg = ndcgAtK(actualOrder, pair.expected_order, 10);

    details.push({
      pair_id: pair.id,
      ndcg_at_10: ndcg,
      passed: ndcg >= threshold,
      actual_order: actualOrder,
      expected_order: pair.expected_order,
    });
  }

  const passed = details.filter((d) => d.passed).length;
  const averageNdcg =
    details.length > 0
      ? details.reduce((sum, d) => sum + d.ndcg_at_10, 0) / details.length
      : 0;

  return {
    total: details.length,
    passed,
    failed: details.length - passed,
    average_ndcg: averageNdcg,
    details,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeResult(
  id: string,
  overrides: Partial<SearchResult> & { bm25_score?: number },
): SearchResult {
  return {
    id,
    score: 0,
    type: 'decision',
    summary: null,
    detail: '',
    author: 'test-author',
    affects: [],
    created_at: new Date().toISOString(),
    status: 'active',
    confidence: null,
    pinned: false,
    depends_on: [],
    bm25_score: 0,
    ...overrides,
  };
}
