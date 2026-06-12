/**
 * Issue #293 (level 2): `upsertDecision` re-upserts chunks with deterministic
 * point IDs, but never deletes stale tail points when the new chunk count is
 * smaller than the previous one — orphan chunks with stale text keep matching
 * searches forever.
 *
 * Contract under test: after upserting N chunks, upsertDecision must issue a
 * filter-delete for points of the same decision with `chunk_index >= N`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { QdrantClient } from '@qdrant/js-client-rest';
import {
  upsertDecision,
  buildContextualText,
} from '../../src/cloud/qdrant/decisions.js';
import { COLLECTION_NAME } from '../../src/cloud/qdrant/client.js';
import { chunkText } from '../../src/cloud/chunking.js';
import type { RawDecision } from '../../src/types.js';

// Skip the live probe inside detectEmbeddingStrategy — server-inference
// strategy builds vectors synchronously from chunk text, no network needed.
process.env.QDRANT_EMBEDDING_STRATEGY = 'server';

function makeFakeQdrant() {
  return {
    upsert: vi.fn().mockResolvedValue({ status: 'completed' }),
    delete: vi.fn().mockResolvedValue({ status: 'completed' }),
  } as unknown as QdrantClient & {
    upsert: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
  };
}

describe('upsertDecision — stale tail-chunk cleanup (#293)', () => {
  let qdrant: ReturnType<typeof makeFakeQdrant>;

  beforeEach(() => {
    qdrant = makeFakeQdrant();
  });

  it('deletes points with chunk_index >= new total after upserting a multi-chunk decision', async () => {
    // ~6KB body → several 1500-char chunks.
    const longText = 'Це довге рішення команди про архітектуру. '.repeat(150);
    const raw: RawDecision = {
      text: longText,
      type: 'decision',
      summary: 'long decision',
      affects: ['architecture'],
    };
    const expectedTotal = chunkText(
      buildContextualText(longText, 'decision', ['architecture']),
    ).length;
    expect(expectedTotal).toBeGreaterThan(1);

    await upsertDecision(qdrant, 'org-1', 'dec-uuid-1', raw, 'dmytro');

    expect(qdrant.delete).toHaveBeenCalledWith(
      COLLECTION_NAME,
      expect.objectContaining({
        filter: {
          must: [
            { key: 'decision_id', match: { value: 'dec-uuid-1' } },
            { key: 'chunk_index', range: { gte: expectedTotal } },
          ],
        },
      }),
    );
  });

  it('still issues the tail-delete for a single-chunk decision (gte: 1)', async () => {
    const raw: RawDecision = {
      text: 'Short decision body — fits one chunk.',
      type: 'decision',
    };

    await upsertDecision(qdrant, 'org-1', 'dec-uuid-2', raw, 'dmytro');

    expect(qdrant.delete).toHaveBeenCalledWith(
      COLLECTION_NAME,
      expect.objectContaining({
        filter: {
          must: [
            { key: 'decision_id', match: { value: 'dec-uuid-2' } },
            { key: 'chunk_index', range: { gte: 1 } },
          ],
        },
      }),
    );
  });

  it('does not fail the upsert when the tail-delete errors (non-blocking cleanup)', async () => {
    qdrant.delete.mockRejectedValueOnce(new Error('qdrant down'));
    const raw: RawDecision = {
      text: 'Short decision body — fits one chunk.',
      type: 'decision',
    };

    await expect(
      upsertDecision(qdrant, 'org-1', 'dec-uuid-3', raw, 'dmytro'),
    ).resolves.toBeUndefined();
  });
});
