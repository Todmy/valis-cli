/**
 * Tests for `createReindexExecutor` (#30 prep — ReindexExecutor production port).
 *
 * Mocks the underlying `reindexAllPoints` to verify the adapter:
 *   - Threads `fromBatchCursor` semantics (idempotency expectations stay intact)
 *   - Emits `onBatchComplete` at ≥50-point thresholds AND a final tail emission
 *   - Returns `{ total_points, final_cursor }` matching the underlying report
 *   - Best-effort: checkpoint write failures don't break the run
 */

import { describe, it, expect, vi } from 'vitest';

const { reindexAllPointsMock } = vi.hoisted(() => ({
  reindexAllPointsMock: vi.fn(),
}));

vi.mock('../../src/cloud/qdrant/admin.js', () => ({
  reindexAllPoints: reindexAllPointsMock,
}));

import { createReindexExecutor } from '../../src/cloud/reindex-executor.js';

describe('createReindexExecutor', () => {
  it('emits onBatchComplete at 50-point thresholds + final emission', async () => {
    // Simulate a run that processes 150 points in three onProgress callbacks.
    reindexAllPointsMock.mockImplementationOnce(
      async (_qdrant: unknown, opts: { onProgress?: (processed: number, total: number) => void | Promise<void> }) => {
        await opts.onProgress?.(50, 150);
        await opts.onProgress?.(100, 150);
        await opts.onProgress?.(150, 150);
        return {
          total: 150,
          reindexed: 150,
          failed: 0,
          skipped: 0,
          durationMs: 1000,
        };
      },
    );

    const cursors: number[] = [];
    const executor = createReindexExecutor({ qdrant: {} as never });
    const result = await executor.run({
      source: 'v1',
      target: 'v2',
      fromBatchCursor: 0,
      onBatchComplete: async (cursor) => {
        cursors.push(cursor);
      },
    });

    expect(result.total_points).toBe(150);
    expect(result.final_cursor).toBe(150);
    // Three threshold emissions (50, 100, 150) + one final tail emission (150) = 4 calls.
    // The final emission is a duplicate of the last threshold — that's deliberate so
    // the checkpoint always captures the completed state even when total < threshold.
    expect(cursors).toEqual([50, 100, 150, 150]);
  });

  it('emits the final cursor even when the total is below the threshold', async () => {
    // Only 25 points — no threshold-triggered emission; the tail is the only one.
    reindexAllPointsMock.mockImplementationOnce(
      async (_qdrant: unknown, opts: { onProgress?: (processed: number, total: number) => void | Promise<void> }) => {
        await opts.onProgress?.(25, 25);
        return {
          total: 25,
          reindexed: 25,
          failed: 0,
          skipped: 0,
          durationMs: 100,
        };
      },
    );

    const cursors: number[] = [];
    const executor = createReindexExecutor({ qdrant: {} as never });
    const result = await executor.run({
      source: 'v1',
      target: 'v2',
      fromBatchCursor: 0,
      onBatchComplete: async (c) => {
        cursors.push(c);
      },
    });

    expect(result.total_points).toBe(25);
    expect(cursors).toEqual([25]); // only the tail emission
  });

  it('does not break the run when onBatchComplete throws', async () => {
    reindexAllPointsMock.mockImplementationOnce(
      async (_qdrant: unknown, opts: { onProgress?: (processed: number, total: number) => void | Promise<void> }) => {
        await opts.onProgress?.(50, 50);
        return {
          total: 50,
          reindexed: 50,
          failed: 0,
          skipped: 0,
          durationMs: 100,
        };
      },
    );

    const executor = createReindexExecutor({ qdrant: {} as never });
    const result = await executor.run({
      source: 'v1',
      target: 'v2',
      fromBatchCursor: 0,
      onBatchComplete: async () => {
        throw new Error('checkpoint write failed');
      },
    });
    // Run completes regardless of checkpoint failures — best-effort persistence.
    expect(result.total_points).toBe(50);
  });
});
