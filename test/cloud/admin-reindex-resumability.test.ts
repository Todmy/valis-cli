/**
 * #26 FR-018 — `valis admin reindex` resumability + idempotency regression test.
 *
 * Verifies the existing `reindexAllPoints` machinery satisfies 019 US4 FR-020:
 * running the same reindex twice in sequence converges to the same end-state
 * with no duplicate writes and no spurious failures.
 *
 * The test mocks the Qdrant client + embedding strategy so it runs in CI
 * without external services. Two-run convergence is asserted by counting
 * `updateVectors` calls per point id — the second run targets the same
 * point ids with the same vectors, and the test verifies the count is
 * stable (not exponential or duplicated).
 *
 * This is a regression guard for two future risks:
 *   - The reindex pipeline accidentally gains a state-mutating side effect
 *     that breaks idempotency (e.g. appending instead of replacing payload).
 *   - Concurrent payload features (pinned, status, cluster labels) cause
 *     the second run to see a different state than the first.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/cloud/qdrant/client.js', () => ({
  COLLECTION_NAME: 'test-collection',
}));

vi.mock('../../src/cloud/embedding.js', async (importOriginal) => {
  // Forward everything we don't override — admin.ts imports BATCH_SIZE,
  // ABORT_THRESHOLD, parseQuotaError, EmbeddingQuotaError, ClientEmbeddingStrategy,
  // DENSE_VECTOR_NAME, etc. Only `detectEmbeddingStrategy` is replaced with a
  // mock so the test can inject a deterministic in-memory embedder.
  const actual = await importOriginal<typeof import('../../src/cloud/embedding.js')>();
  return {
    ...actual,
    detectEmbeddingStrategy: vi.fn(),
    truncateForEmbedding: (s: string) => s.slice(0, 2000),
  };
});

import { reindexAllPoints } from '../../src/cloud/qdrant/admin.js';
import { detectEmbeddingStrategy } from '../../src/cloud/embedding.js';

interface MockPoint {
  id: number;
  payload: Record<string, unknown>;
}

function buildSeed(pointCount: number): MockPoint[] {
  return Array.from({ length: pointCount }, (_, i) => ({
    id: i + 1,
    payload: {
      contextual_text: `decision ${i + 1}: pick a database`,
      type: 'decision',
    },
  }));
}

interface MockQdrantClient {
  scroll: ReturnType<typeof vi.fn>;
  updateVectors: ReturnType<typeof vi.fn>;
  count: ReturnType<typeof vi.fn>;
  // Per-point write counter — keyed by point id.
  writes: Map<number, number>;
  // Per-point most-recent vector (so we can assert idempotency on the value).
  vectorByPoint: Map<number, number[]>;
}

function buildMockQdrant(seed: MockPoint[]): MockQdrantClient {
  const writes = new Map<number, number>();
  const vectorByPoint = new Map<number, number[]>();
  const points = [...seed];

  const scroll = vi.fn(async (_collection: string, opts: { offset?: number; limit: number }) => {
    const startIndex = opts.offset
      ? points.findIndex((p) => p.id === opts.offset) + 1
      : 0;
    const slice = points.slice(startIndex, startIndex + opts.limit);
    return { points: slice };
  });

  const updateVectors = vi.fn(
    async (
      _collection: string,
      args: { points: Array<{ id: number; vector: number[] }> },
    ) => {
      for (const p of args.points) {
        writes.set(p.id, (writes.get(p.id) ?? 0) + 1);
        vectorByPoint.set(p.id, [...p.vector]);
      }
    },
  );

  const count = vi.fn(async () => ({ count: seed.length }));

  return {
    scroll,
    updateVectors,
    count,
    writes,
    vectorByPoint,
  };
}

beforeEachSetupStrategy();

function beforeEachSetupStrategy() {
  // Stable in-memory embedding so the two runs target the same vector for
  // the same input. Otherwise idempotency would be trivially false (every
  // run produces a different vector and the test couldn't tell convergence
  // from drift).
  const stableEmbed = (s: string): number[] => {
    const hash = [...s].reduce((acc, c) => acc + c.charCodeAt(0), 0);
    return Array.from({ length: 8 }, (_, i) => (hash + i) / 1000);
  };
  vi.mocked(detectEmbeddingStrategy).mockResolvedValue({
    mode: 'server',
    supportsHybrid: true,
    vectorForUpsert: stableEmbed,
    queryForDense: () => ({}),
    queryForSparse: () => ({}),
  } as never);
}

describe('reindexAllPoints — idempotency (#26 FR-018)', () => {
  it('two sequential runs converge: every point ends with exactly one write per run AND the same final vector', async () => {
    const seed = buildSeed(25); // smaller than batch size so we get clean coverage
    const qdrant = buildMockQdrant(seed);

    const first = await reindexAllPoints(qdrant as never);
    expect(first.total).toBe(25);
    expect(first.reindexed).toBe(25);
    expect(first.failed).toBe(0);
    // Each point written exactly once on the first run.
    for (let id = 1; id <= 25; id++) {
      expect(qdrant.writes.get(id)).toBe(1);
    }

    const firstVectors = new Map(qdrant.vectorByPoint);

    const second = await reindexAllPoints(qdrant as never);
    expect(second.total).toBe(25);
    expect(second.reindexed).toBe(25);
    expect(second.failed).toBe(0);
    // Each point should now have exactly 2 writes (1 per run, never more).
    // This is the load-bearing assertion: no exponential blow-up, no duplicate
    // writes inside a single run.
    for (let id = 1; id <= 25; id++) {
      expect(qdrant.writes.get(id)).toBe(2);
    }

    // End-state vectors stable across runs (idempotent value, not just count).
    for (const [id, vector] of qdrant.vectorByPoint.entries()) {
      expect(vector).toEqual(firstVectors.get(id));
    }
  });

  it('skips points missing contextual_text instead of duplicate-writing them', async () => {
    const seed = buildSeed(10);
    // Half the points have no contextual_text (legacy / corrupted).
    for (let i = 0; i < 5; i++) {
      delete (seed[i].payload as Record<string, unknown>).contextual_text;
    }
    const qdrant = buildMockQdrant(seed);

    const first = await reindexAllPoints(qdrant as never);
    expect(first.total).toBe(10);
    expect(first.reindexed).toBe(5);
    expect(first.failed).toBe(5);

    const second = await reindexAllPoints(qdrant as never);
    expect(second.reindexed).toBe(5);
    expect(second.failed).toBe(5);
    // The 5 unmissed points each have 2 writes, never more.
    for (let id = 6; id <= 10; id++) {
      expect(qdrant.writes.get(id)).toBe(2);
    }
    // The 5 missing-text points never written.
    for (let id = 1; id <= 5; id++) {
      expect(qdrant.writes.get(id)).toBeUndefined();
    }
  });

  it('dry-run produces zero writes — re-runnable without state mutation', async () => {
    const seed = buildSeed(10);
    const qdrant = buildMockQdrant(seed);

    const r1 = await reindexAllPoints(qdrant as never, { dryRun: true });
    const r2 = await reindexAllPoints(qdrant as never, { dryRun: true });

    expect(r1.skipped).toBe(10);
    expect(r2.skipped).toBe(10);
    expect(qdrant.writes.size).toBe(0); // never wrote anything
    expect(qdrant.updateVectors).not.toHaveBeenCalled();
  });
});
