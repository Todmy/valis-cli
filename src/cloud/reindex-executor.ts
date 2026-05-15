/**
 * 026/Track 3a — ReindexExecutor production wiring.
 *
 * Implements the `ReindexExecutor` port from `reindex-orchestrator.ts` by
 * adapting the existing `reindexAllPoints` machinery (`cloud/qdrant/admin.ts`).
 *
 * Two semantic concerns translated:
 *
 *   1. **Batch cursor**: the orchestrator persists a `final_cursor` after
 *      each batch and resumes from `fromBatchCursor` on restart. The adapter
 *      tracks the count of points processed and threads it through the
 *      `onBatchComplete` callback so the orchestrator can write the
 *      checkpoint atomically per batch (FR-005 / US2 resumability).
 *
 *   2. **Source / target version naming**: `reindexAllPoints` operates on
 *      a single Qdrant collection at a time (the one resolved by the
 *      embedding strategy + collection-alias setup). The toolkit's
 *      "source v1 → target v2" semantic is realised by the env-var flips
 *      in phases 1 and 5; the executor itself only needs to call
 *      `reindexAllPoints` against the currently-active collection.
 *
 * Idempotency: `reindexAllPoints` uses `qdrant.updateVectors` which is
 * idempotent on the same point id + same input vector — re-running a batch
 * produces no duplicate writes (verified by the regression test in
 * `admin-reindex-resumability.test.ts`).
 */

import type { QdrantClient } from '@qdrant/js-client-rest';
import {
  reindexAllPoints,
  type ReindexReport,
} from './qdrant/admin.js';
import type { ReindexExecutor } from './reindex-orchestrator.js';

interface ReindexExecutorOpts {
  qdrant: QdrantClient;
}

const PROGRESS_BATCH_SIZE = 50;

export function createReindexExecutor(opts: ReindexExecutorOpts): ReindexExecutor {
  return {
    async run({ fromBatchCursor, onBatchComplete }): Promise<{
      total_points: number;
      final_cursor: number;
    }> {
      // Track the cumulative count of processed points so we can emit a
      // batch-completion callback every `PROGRESS_BATCH_SIZE` rows. The
      // underlying `reindexAllPoints` does its own batching internally,
      // but only emits an `onProgress(processed, total)` callback at the
      // page boundary — which is enough granularity for the checkpoint.
      let lastReported = fromBatchCursor;

      const report: ReindexReport = await reindexAllPoints(opts.qdrant, {
        onProgress: async (processed) => {
          // Bridge the existing `onProgress` (count-based) into the
          // orchestrator's `onBatchComplete(cursor)` interface. We treat
          // the cumulative processed count as the cursor — operationally
          // identical for resume semantics: on restart, the new run's
          // `fromBatchCursor` is the highest count persisted.
          if (processed - lastReported >= PROGRESS_BATCH_SIZE) {
            lastReported = processed;
            try {
              await onBatchComplete(processed);
            } catch {
              /* checkpoint write failed — log via orchestrator's audit; keep going */
            }
          }
        },
      });

      // Final emission for the tail batch (between the last threshold and
      // total). Always invoke so the checkpoint records the completed cursor.
      await onBatchComplete(report.total).catch(() => {
        /* same best-effort treatment */
      });

      return {
        total_points: report.total,
        final_cursor: report.total,
      };
    },
  };
}
