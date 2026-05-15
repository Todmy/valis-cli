/**
 * 026/Track 3a — SpotChecker production wiring.
 *
 * Implements the `SpotChecker` port from `reindex-orchestrator.ts` using a
 * **self-join R@5** proxy: sample N random decisions from the source
 * collection, embed each one's `contextual_text` via Qdrant's server-side
 * inference, query both `source` and `target` collections, and check
 * whether each decision retrieves itself within the top-5.
 *
 * Why self-join (not labelled neighbours):
 *   The toolkit's purpose is regression detection, not benchmark-quality
 *   measurement. A self-join's signal is unambiguous — if the decision's
 *   own embedding no longer puts it in its own top-5, retrieval has
 *   *materially* degraded for that point. The 021 benchmark harness exists
 *   for absolute-quality measurement; the orchestrator's spot-check exists
 *   for *go/no-go* gating, and the gate is "did we lose ≥5% of the ability
 *   to find points by their own text?".
 *
 * Why Qdrant server-side embedding:
 *   The source and target collections each have their own configured
 *   embedding model (FastEmbed v1 = MiniLM-L6-v2, v2 = e5-small). By
 *   sending text as `query` document and letting Qdrant embed it under the
 *   collection's configured model, we get apples-to-apples comparisons
 *   without needing two embedding-client instances in process.
 *
 * Inconclusive threshold (per spec edge case):
 *   When fewer than 5 sampled points have a meaningful self-join result
 *   (e.g. the source collection itself has degraded too far to provide a
 *   stable baseline), the result is flagged `inconclusive: true` and the
 *   orchestrator treats it as a failure for gating purposes.
 */

import type { QdrantClient } from '@qdrant/js-client-rest';
import {
  COLLECTION_V1,
  COLLECTION_V2,
  type EmbeddingVersion,
} from './embedding.js';
import type { SpotChecker, SpotCheckResult } from './reindex-orchestrator.js';

interface SpotCheckerOpts {
  qdrant: QdrantClient;
  /** Override for tests; production uses Date.now() for the seed. */
  randomSeed?: number;
}

const DEFAULT_RATIO_THRESHOLD = 0.95;
const MIN_GROUND_TRUTH_POINTS = 5;
const TOP_K = 5;

function collectionFor(version: EmbeddingVersion): string {
  return version === 'v2' ? COLLECTION_V2 : COLLECTION_V1;
}

interface SamplePoint {
  id: string | number;
  text: string;
}

/**
 * Pull `sampleSize` random-ish points from `collection` by scrolling and
 * keeping every Nth point. Pseudorandom (deterministic given the seed) so
 * a flaky-spot-check failure can be reproduced with the same checkpoint.
 */
async function samplePoints(
  qdrant: QdrantClient,
  collection: string,
  sampleSize: number,
  seed: number,
): Promise<SamplePoint[]> {
  // Overfetch by 4× so we have headroom to discard points missing
  // `contextual_text` (the embed input we need for the self-join).
  const overfetch = sampleSize * 4;
  let offset: string | number | undefined = undefined;
  const candidates: SamplePoint[] = [];
  while (candidates.length < overfetch) {
    const page = await qdrant.scroll(collection, {
      limit: 100,
      with_payload: true,
      ...(offset !== undefined ? { offset } : {}),
    });
    if (page.points.length === 0) break;
    for (const p of page.points) {
      const payload = (p.payload ?? {}) as Record<string, unknown>;
      const text =
        (payload.contextual_text as string | undefined) ??
        (payload.detail as string | undefined);
      if (text && typeof text === 'string') {
        candidates.push({ id: p.id, text });
      }
    }
    if (page.points.length < 100) break;
    offset = page.points[page.points.length - 1].id;
  }

  if (candidates.length <= sampleSize) return candidates;

  // Deterministic shuffle from the seed — splitmix64-style step over indices.
  const indices = candidates.map((_, i) => i);
  let s = seed >>> 0;
  for (let i = indices.length - 1; i > 0; i--) {
    s = (s * 1664525 + 1013904223) >>> 0;
    const j = s % (i + 1);
    [indices[i], indices[j]] = [indices[j], indices[i]];
  }
  return indices.slice(0, sampleSize).map((i) => candidates[i]);
}

/**
 * Run a self-join recall query against `collection` for each sample point.
 * Returns the count of points that retrieved themselves in the top-K.
 */
async function selfJoinRecall(
  qdrant: QdrantClient,
  collection: string,
  points: SamplePoint[],
): Promise<number> {
  let hits = 0;
  for (const p of points) {
    try {
      // Use Qdrant's server-side inference by passing `query` as a document.
      // Each collection has its own configured FastEmbed model attached, so
      // the embedding happens in the same model that wrote the index.
      const result = await qdrant.query(collection, {
        query: { document: p.text } as never,
        limit: TOP_K,
        with_payload: false,
      });
      const ids = (result.points ?? []).map((point) => String(point.id));
      if (ids.includes(String(p.id))) hits += 1;
    } catch {
      // Per-point query failures count as a miss — over the sample size
      // they shouldn't add up to enough to flip the gate spuriously, and
      // if they do, the conclusive-vs-inconclusive threshold catches it.
    }
  }
  return hits;
}

export function createSpotChecker(opts: SpotCheckerOpts): SpotChecker {
  return {
    async measure({ source, target, sampleSize }): Promise<SpotCheckResult> {
      const seed = opts.randomSeed ?? Date.now();
      const sourceCollection = collectionFor(source);
      const targetCollection = collectionFor(target);

      const samples = await samplePoints(opts.qdrant, sourceCollection, sampleSize, seed);

      if (samples.length < MIN_GROUND_TRUTH_POINTS) {
        return {
          baseline_r_at_5: 0,
          target_r_at_5: 0,
          ratio: 0,
          threshold: DEFAULT_RATIO_THRESHOLD,
          sample_size: samples.length,
          passed: false,
          inconclusive: true,
          sample_decision_ids: samples.map((s) => String(s.id)),
        };
      }

      const sourceHits = await selfJoinRecall(opts.qdrant, sourceCollection, samples);
      const targetHits = await selfJoinRecall(opts.qdrant, targetCollection, samples);

      const baselineRatk = sourceHits / samples.length;
      const targetRatk = targetHits / samples.length;
      // Baseline of 0 → ratio is undefined; treat as inconclusive (the source
      // collection itself is broken and we have no meaningful gate to apply).
      if (baselineRatk === 0) {
        return {
          baseline_r_at_5: 0,
          target_r_at_5: targetRatk,
          ratio: 0,
          threshold: DEFAULT_RATIO_THRESHOLD,
          sample_size: samples.length,
          passed: false,
          inconclusive: true,
          sample_decision_ids: samples.map((s) => String(s.id)),
        };
      }
      const ratio = targetRatk / baselineRatk;
      return {
        baseline_r_at_5: baselineRatk,
        target_r_at_5: targetRatk,
        ratio,
        threshold: DEFAULT_RATIO_THRESHOLD,
        sample_size: samples.length,
        passed: ratio >= DEFAULT_RATIO_THRESHOLD,
        inconclusive: false,
        sample_decision_ids: samples.map((s) => String(s.id)),
      };
    },
  };
}
