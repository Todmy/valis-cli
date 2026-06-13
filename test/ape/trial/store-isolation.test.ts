/**
 * 285/T011: trial store isolation.
 *
 * guardTrialStore(payload) is the fail-closed guard wrapping any store a trial
 * performs. It (a) forces `status='proposed'` even if `active` was requested
 * (const IX/IV — trial stores never go `active`), (b) routes the vector write
 * to a `valis_bench_<runId>` ephemeral collection (never the prod collection),
 * and (c) throws if production Qdrant creds (`PROD_QDRANT_URL`) are present
 * without the benchmark-scoped `BENCHMARK_QDRANT_URL` — fail-closed so trial
 * traffic can never touch the production cluster.
 *
 * Mirrors `packages/cli/src/benchmarks/seed.ts` (ephemeral collection +
 * `BENCHMARK_QDRANT_*`) and `normalizeStoreStatus` in `packages/cli/src/types.ts`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { guardTrialStore, type TrialStorePayload } from '../../../src/ape/trial/store-isolation.js';

const ENV_KEYS = ['PROD_QDRANT_URL', 'BENCHMARK_QDRANT_URL'] as const;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const basePayload = (): TrialStorePayload => ({
  runId: 'run-abc',
  status: 'active',
  collection: 'valis_decisions',
  summary: 'a trial-time store',
});

describe('guardTrialStore', () => {
  it('forces status proposed even if active requested', () => {
    process.env.BENCHMARK_QDRANT_URL = 'https://bench.example';
    const out = guardTrialStore(basePayload());
    expect(out.status).toBe('proposed');
  });

  it('targets ephemeral collection name', () => {
    process.env.BENCHMARK_QDRANT_URL = 'https://bench.example';
    const out = guardTrialStore(basePayload());
    expect(out.collection).toBe('valis_bench_run-abc');
  });

  it('throws if PROD_QDRANT_URL present without BENCHMARK_QDRANT_URL', () => {
    process.env.PROD_QDRANT_URL = 'https://prod.qdrant.example';
    expect(() => guardTrialStore(basePayload())).toThrow(/prod/i);
  });
});
