/**
 * 021/T007: pure-function retrieval metrics — recall@k, MRR, nDCG@k.
 *
 * Contract documented in `specs/021-public-benchmarks/data-model.md`:
 * - Inputs are `{hits, groundTruth}` pairs already aligned per query.
 * - Outputs are scalars in [0, 1] averaged across the input queries.
 * - No I/O, no dependencies beyond shared types.
 * - Throws when `k < 1` or `results.length === 0` — callers must
 *   pre-validate. Failing loud here surfaces silent harness bugs
 *   (e.g., dropping all queries due to a corpus mismatch).
 */

import type { GroundTruth, SearchHit } from './types.js';

interface QueryResult {
  hits: SearchHit[];
  groundTruth: GroundTruth;
}

type Results = ReadonlyArray<QueryResult>;

function assertNonEmpty(results: Results, fn: string): void {
  if (results.length === 0) {
    throw new Error(`${fn}: results must contain at least one query`);
  }
}

function assertK(k: number, fn: string): void {
  if (!Number.isFinite(k) || k < 1) {
    throw new Error(`${fn}: k must be a positive integer (got ${k})`);
  }
}

function relevantSet(groundTruth: GroundTruth): Set<string> {
  return new Set(groundTruth.relevant_doc_ids ?? []);
}

/**
 * Recall@k — fraction of queries for which at least one relevant doc appears
 * in the top-k retrieved hits.
 */
export function recallAtK(results: Results, k: number): number {
  assertNonEmpty(results, 'recallAtK');
  assertK(k, 'recallAtK');

  let hits = 0;
  for (const { hits: docHits, groundTruth } of results) {
    const relevant = relevantSet(groundTruth);
    if (relevant.size === 0) continue;
    const topK = docHits.slice(0, k);
    if (topK.some((h) => relevant.has(h.doc_id))) hits += 1;
  }
  return hits / results.length;
}

/**
 * Mean Reciprocal Rank — averaged 1/rank-of-first-relevant-hit across queries.
 * Queries with no relevant hit (or empty hits) contribute 0.
 */
export function mrr(results: Results): number {
  assertNonEmpty(results, 'mrr');

  let sum = 0;
  for (const { hits, groundTruth } of results) {
    const relevant = relevantSet(groundTruth);
    if (relevant.size === 0) continue;
    const found = hits.find((h) => relevant.has(h.doc_id));
    if (found) sum += 1 / found.rank;
  }
  return sum / results.length;
}

/**
 * nDCG@k with binary relevance.
 *
 *   DCG  = Σ_{i=1..k}  rel_i / log2(i + 1)            where rel_i ∈ {0,1}
 *   IDCG = Σ_{i=1..min(k,|relevant|)} 1 / log2(i + 1)
 *
 * Per-query nDCG is 0 by convention when IDCG is 0 (no relevant docs).
 */
export function ndcgAtK(results: Results, k: number): number {
  assertNonEmpty(results, 'ndcgAtK');
  assertK(k, 'ndcgAtK');

  let sum = 0;
  for (const { hits, groundTruth } of results) {
    const relevant = relevantSet(groundTruth);
    if (relevant.size === 0) continue;

    const topK = hits.slice(0, k);
    let dcg = 0;
    for (let i = 0; i < topK.length; i++) {
      if (relevant.has(topK[i].doc_id)) {
        dcg += 1 / Math.log2(i + 2);
      }
    }

    const idealCount = Math.min(k, relevant.size);
    let idcg = 0;
    for (let i = 0; i < idealCount; i++) {
      idcg += 1 / Math.log2(i + 2);
    }
    if (idcg > 0) sum += dcg / idcg;
  }
  return sum / results.length;
}
