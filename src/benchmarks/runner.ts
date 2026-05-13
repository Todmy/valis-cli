/**
 * 021/T017: benchmark runner — orchestrates one corpus through the three
 * search strategies and produces a `SliceResult`.
 *
 * Responsibilities:
 *   - Iterate `corpus.queries`, call each strategy's `searchFn(text, k=10)`.
 *   - Assert the searchFn contract per query (1-based contiguous ranks, no
 *     duplicates, length ≤ k). Any violation throws — do NOT silently skip.
 *   - Compute `recall_at_5`, `recall_at_10`, `mrr`, `ndcg_at_10` for each
 *     strategy via the pure metric functions in `metrics.ts`.
 *   - Stamp `wall_clock_ms` per strategy.
 *   - Flag `gate_passed = hybrid.recall_at_5 >= 0.80`.
 *
 * Out of scope here: seeding Qdrant, dropping collections, writing JSON.
 * Caller wires those in `index.ts#runBenchmark`.
 */

import { recallAtK, mrr, ndcgAtK } from './metrics.js';
import type {
  CorpusSlice,
  GroundTruth,
  MetricSet,
  MetricsByStrategy,
  SearchFn,
  SearchHit,
  SliceResult,
  Strategy,
} from './types.js';

export const HYBRID_GATE_R5 = 0.8;
export const DEFAULT_K = 10;

export interface RunOptions {
  corpus: CorpusSlice;
  searchFns: Record<Strategy, SearchFn>;
  metricsK: { recall: number[]; ndcg: number };
  onProgress?: (percent: number, label?: string) => void;
}

interface QueryResult {
  hits: SearchHit[];
  groundTruth: GroundTruth;
}

function assertSearchFnContract(
  hits: SearchHit[],
  k: number,
  queryId: string,
): void {
  if (hits.length > k) {
    throw new Error(
      `searchFn contract violation (q=${queryId}): result length ${hits.length} exceeds k=${k}`,
    );
  }
  const seen = new Set<string>();
  for (let i = 0; i < hits.length; i++) {
    const expected = i + 1;
    if (hits[i].rank !== expected) {
      throw new Error(
        `searchFn contract violation (q=${queryId}): rank at index ${i} is ${hits[i].rank}, expected ${expected}`,
      );
    }
    if (seen.has(hits[i].doc_id)) {
      throw new Error(
        `searchFn contract violation (q=${queryId}): duplicate doc_id ${hits[i].doc_id}`,
      );
    }
    seen.add(hits[i].doc_id);
  }
}

async function runStrategy(
  corpus: CorpusSlice,
  searchFn: SearchFn,
  metricsK: { recall: number[]; ndcg: number },
  onProgress: ((percent: number) => void) | undefined,
  strategyLabel: Strategy,
): Promise<MetricSet> {
  const t0 = Date.now();
  const gtIndex = new Map<string, GroundTruth>(
    corpus.ground_truth.map((g) => [g.query_id, g]),
  );

  const queryResults: QueryResult[] = [];
  for (let i = 0; i < corpus.queries.length; i++) {
    const query = corpus.queries[i];
    const groundTruth = gtIndex.get(query.id);
    if (!groundTruth) continue; // no GT for this query — informational only
    const hits = await searchFn(query.text, DEFAULT_K);
    assertSearchFnContract(hits, DEFAULT_K, query.id);
    queryResults.push({ hits, groundTruth });

    if (onProgress) {
      const pct =
        ((i + 1) / corpus.queries.length) * 100;
      onProgress(pct);
    }
  }

  const wallClockMs = Date.now() - t0;

  if (queryResults.length === 0) {
    return {
      recall_at_5: 0,
      recall_at_10: 0,
      mrr: 0,
      ndcg_at_10: 0,
      wall_clock_ms: wallClockMs,
      n_queries_evaluated: 0,
    };
  }

  void strategyLabel; // reserved for future per-strategy debug logs
  return {
    recall_at_5: recallAtK(queryResults, metricsK.recall[0] ?? 5),
    recall_at_10: recallAtK(queryResults, metricsK.recall[1] ?? 10),
    mrr: mrr(queryResults),
    ndcg_at_10: ndcgAtK(queryResults, metricsK.ndcg),
    wall_clock_ms: wallClockMs,
    n_queries_evaluated: queryResults.length,
  };
}

export async function run(options: RunOptions): Promise<SliceResult> {
  const { corpus, searchFns, metricsK, onProgress } = options;

  const strategies: Strategy[] = ['hybrid', 'dense_only', 'bm25_only'];
  const metrics = {} as MetricsByStrategy;

  for (let s = 0; s < strategies.length; s++) {
    const strategy = strategies[s];
    const stratProgress = onProgress
      ? (queryPct: number): void => {
          // Combine per-query progress with per-strategy progress so the
          // overall percent is monotonic across the whole slice run.
          const stratWeight = 100 / strategies.length;
          const overall = stratWeight * s + (queryPct / 100) * stratWeight;
          onProgress(Math.min(100, overall), strategy);
        }
      : undefined;
    metrics[strategy] = await runStrategy(
      corpus,
      searchFns[strategy],
      metricsK,
      stratProgress,
      strategy,
    );
  }

  const gatePassed = metrics.hybrid.recall_at_5 >= HYBRID_GATE_R5;

  return {
    corpus: corpus.id,
    language: corpus.language,
    n_queries: corpus.queries.length,
    n_documents: corpus.documents.length,
    metrics,
    gate_passed: gatePassed,
  };
}
