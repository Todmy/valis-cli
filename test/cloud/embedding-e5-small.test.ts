/**
 * Multilingual e5-small strategy assertions (post-v1-removal).
 *
 * Verifies the ServerInferenceStrategy emits Document shapes with the
 * intfloat/multilingual-e5-small model, and the char ceiling truncates
 * input correctly.
 *
 * Prior versions of this file also tested the v1 (MiniLM) side and a
 * version-aware `vectorForUpsertAtVersion` helper — those were dropped
 * during the 2026-05-18 v1 removal sweep (specs/019 baselines confirmed
 * e5-small wins on every multilingual slice with zero EN regression).
 */

import { describe, it, expect } from 'vitest';
import {
  ServerInferenceStrategy,
  truncateForEmbedding,
  DENSE_MODEL,
  VECTOR_SIZE,
  MAX_EMBEDDING_INPUT_CHARS,
  BM25_MODEL,
  DENSE_VECTOR_NAME,
  BM25_VECTOR_NAME,
} from '../../src/cloud/embedding.js';

describe('e5-small constants', () => {
  it('DENSE_MODEL is intfloat/multilingual-e5-small', () => {
    expect(DENSE_MODEL).toBe('intfloat/multilingual-e5-small');
  });

  it('VECTOR_SIZE = 384', () => {
    expect(VECTOR_SIZE).toBe(384);
  });

  it('MAX_EMBEDDING_INPUT_CHARS = 2000 (~512-token window with multilingual safety)', () => {
    expect(MAX_EMBEDDING_INPUT_CHARS).toBe(2000);
  });
});

describe('ServerInferenceStrategy', () => {
  it('vectorForUpsert emits e5-small dense + bm25 sparse Document', () => {
    const strat = new ServerInferenceStrategy();
    const v = strat.vectorForUpsert('text');
    expect(v).toEqual({
      [DENSE_VECTOR_NAME]: { text: 'text', model: DENSE_MODEL },
      [BM25_VECTOR_NAME]: { text: 'text', model: BM25_MODEL },
    });
  });

  it('queryForDense uses e5-small model', () => {
    const strat = new ServerInferenceStrategy();
    expect(strat.queryForDense('q')).toEqual({ text: 'q', model: DENSE_MODEL });
  });

  it('queryForSparse uses BM25 model', () => {
    const strat = new ServerInferenceStrategy();
    expect(strat.queryForSparse('q')).toEqual({ text: 'q', model: BM25_MODEL });
  });
});

describe('truncateForEmbedding', () => {
  it('leaves text under the ceiling untouched', () => {
    const text = 'a'.repeat(MAX_EMBEDDING_INPUT_CHARS);
    expect(truncateForEmbedding(text)).toEqual(text);
  });

  it('truncates inputs above the ceiling', () => {
    const text = 'a'.repeat(MAX_EMBEDDING_INPUT_CHARS + 100);
    const out = truncateForEmbedding(text);
    expect(out).toHaveLength(MAX_EMBEDDING_INPUT_CHARS);
  });
});
