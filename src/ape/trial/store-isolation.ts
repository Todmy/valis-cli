/**
 * 285/T011: trial store isolation — proposed + ephemeral, fail-closed.
 *
 * Any store a trial performs MUST be neutralised before it can touch prod:
 *   - status normalised to 'proposed' (const IX/IV — never `active`), mirroring
 *     `normalizeStoreStatus` in `packages/cli/src/types.ts`.
 *   - the vector write is routed to a `valis_bench_<runId>` ephemeral collection
 *     (the same naming the 021 benchmark seeder uses in `benchmarks/seed.ts`),
 *     never the production collection.
 *   - if production Qdrant creds (`PROD_QDRANT_URL`) are visible WITHOUT the
 *     benchmark-scoped `BENCHMARK_QDRANT_URL`, the guard throws (fail-closed) so
 *     trial traffic can never reach the production cluster.
 */

export interface TrialStorePayload {
  /** Run id that scopes the ephemeral collection. */
  runId: string;
  /** Requested store status — coerced to 'proposed' here. */
  status?: string;
  /** Requested target collection — rerouted to the ephemeral name here. */
  collection?: string;
  /** Remaining payload fields are passed through untouched. */
  [key: string]: unknown;
}

/**
 * Guard a trial-time store payload. Returns a new payload with `status` forced
 * to 'proposed' and `collection` rerouted to `valis_bench_<runId>`. Throws if
 * prod Qdrant creds are present without a benchmark override.
 */
export function guardTrialStore(payload: TrialStorePayload): TrialStorePayload {
  if (process.env.PROD_QDRANT_URL && !process.env.BENCHMARK_QDRANT_URL) {
    throw new Error(
      'guardTrialStore: PROD_QDRANT_URL is set without BENCHMARK_QDRANT_URL — ' +
        'refusing to run a trial store against the production cluster (fail-closed). ' +
        'Set BENCHMARK_QDRANT_URL to an ephemeral cluster, mirroring benchmarks/seed.ts.',
    );
  }
  return {
    ...payload,
    status: 'proposed',
    collection: `valis_bench_${payload.runId}`,
  };
}
