/**
 * 019/US4 / T030 — bge-m3 strategy assertions.
 *
 * Verifies the v2 ServerInferenceStrategy emits Document shapes with the
 * bge-m3 model, the v2 char ceiling truncates input correctly, and
 * vectorForUpsertAtVersion produces the right model per version.
 */

import { describe, it, expect } from 'vitest';
import {
  ServerInferenceStrategy,
  truncateForEmbedding,
  vectorForUpsertAtVersion,
  DENSE_MODEL_V1,
  DENSE_MODEL_V2,
  VECTOR_SIZE_V1,
  VECTOR_SIZE_V2,
  MAX_EMBEDDING_INPUT_CHARS_V1,
  MAX_EMBEDDING_INPUT_CHARS_V2,
  BM25_MODEL,
  DENSE_VECTOR_NAME,
  BM25_VECTOR_NAME,
  getDenseModel,
  getVectorSize,
  getMaxEmbeddingInputChars,
  type EmbeddingVersion,
} from '../../src/cloud/embedding.js';

describe('US4 — bge-m3 v2 strategy', () => {
  it('VECTOR_SIZE_V2 = 1024 (bge-m3 dimensionality)', () => {
    expect(VECTOR_SIZE_V2).toBe(1024);
  });

  it('VECTOR_SIZE_V1 = 384 (legacy MiniLM)', () => {
    expect(VECTOR_SIZE_V1).toBe(384);
  });

  it('DENSE_MODEL_V2 is BAAI/bge-m3', () => {
    expect(DENSE_MODEL_V2).toBe('BAAI/bge-m3');
  });

  it('DENSE_MODEL_V1 is the legacy MiniLM identifier', () => {
    expect(DENSE_MODEL_V1).toBe('sentence-transformers/all-MiniLM-L6-v2');
  });

  it('MAX_EMBEDDING_INPUT_CHARS_V2 = 24000 (8K-token window × ~3 char/token)', () => {
    expect(MAX_EMBEDDING_INPUT_CHARS_V2).toBe(24000);
  });

  it('MAX_EMBEDDING_INPUT_CHARS_V1 = 2000 (legacy 512-token window)', () => {
    expect(MAX_EMBEDDING_INPUT_CHARS_V1).toBe(2000);
  });

  it('ServerInferenceStrategy("v2") vectorForUpsert emits bge-m3 Document', () => {
    const strat = new ServerInferenceStrategy('v2');
    const v = strat.vectorForUpsert('text');
    expect(v).toEqual({
      [DENSE_VECTOR_NAME]: { text: 'text', model: 'BAAI/bge-m3' },
      [BM25_VECTOR_NAME]: { text: 'text', model: BM25_MODEL },
    });
  });

  it('ServerInferenceStrategy("v1") vectorForUpsert keeps the MiniLM Document', () => {
    const strat = new ServerInferenceStrategy('v1');
    const v = strat.vectorForUpsert('text');
    expect(v).toEqual({
      [DENSE_VECTOR_NAME]: { text: 'text', model: 'sentence-transformers/all-MiniLM-L6-v2' },
      [BM25_VECTOR_NAME]: { text: 'text', model: BM25_MODEL },
    });
  });

  it('queryForDense respects construction-time version', () => {
    const v1 = new ServerInferenceStrategy('v1');
    const v2 = new ServerInferenceStrategy('v2');
    expect(v1.queryForDense('q')).toEqual({ text: 'q', model: DENSE_MODEL_V1 });
    expect(v2.queryForDense('q')).toEqual({ text: 'q', model: DENSE_MODEL_V2 });
  });
});

describe('US4 — truncation', () => {
  it('v2: leaves text under 24000 chars untouched', () => {
    const text = 'a'.repeat(MAX_EMBEDDING_INPUT_CHARS_V2);
    expect(truncateForEmbedding(text, 'v2')).toEqual(text);
  });

  it('v2: truncates inputs above 24000 chars', () => {
    const text = 'a'.repeat(MAX_EMBEDDING_INPUT_CHARS_V2 + 100);
    const out = truncateForEmbedding(text, 'v2');
    expect(out).toHaveLength(MAX_EMBEDDING_INPUT_CHARS_V2);
  });

  it('v1: still truncates at the legacy 2000-char ceiling', () => {
    const text = 'a'.repeat(MAX_EMBEDDING_INPUT_CHARS_V1 + 100);
    const out = truncateForEmbedding(text, 'v1');
    expect(out).toHaveLength(MAX_EMBEDDING_INPUT_CHARS_V1);
  });

  it('v1 ceiling differs from v2 ceiling', () => {
    expect(MAX_EMBEDDING_INPUT_CHARS_V1).not.toEqual(MAX_EMBEDDING_INPUT_CHARS_V2);
  });
});

describe('US4 — vectorForUpsertAtVersion', () => {
  it('v2 truncates against the v2 ceiling and uses bge-m3', () => {
    const long = 'b'.repeat(MAX_EMBEDDING_INPUT_CHARS_V2 + 50);
    const out = vectorForUpsertAtVersion(long, 'v2') as Record<string, { text: string; model: string }>;
    expect(out[DENSE_VECTOR_NAME].text).toHaveLength(MAX_EMBEDDING_INPUT_CHARS_V2);
    expect(out[DENSE_VECTOR_NAME].model).toBe('BAAI/bge-m3');
  });

  it('v1 truncates against the v1 ceiling and uses MiniLM', () => {
    const long = 'b'.repeat(MAX_EMBEDDING_INPUT_CHARS_V1 + 50);
    const out = vectorForUpsertAtVersion(long, 'v1') as Record<string, { text: string; model: string }>;
    expect(out[DENSE_VECTOR_NAME].text).toHaveLength(MAX_EMBEDDING_INPUT_CHARS_V1);
    expect(out[DENSE_VECTOR_NAME].model).toBe(DENSE_MODEL_V1);
  });
});

describe('US4 — version getters', () => {
  it.each<[EmbeddingVersion, string, number, number]>([
    ['v1', DENSE_MODEL_V1, VECTOR_SIZE_V1, MAX_EMBEDDING_INPUT_CHARS_V1],
    ['v2', DENSE_MODEL_V2, VECTOR_SIZE_V2, MAX_EMBEDDING_INPUT_CHARS_V2],
  ])('%s: returns the right (model, size, ceiling) tuple', (v, model, size, ceiling) => {
    expect(getDenseModel(v)).toBe(model);
    expect(getVectorSize(v)).toBe(size);
    expect(getMaxEmbeddingInputChars(v)).toBe(ceiling);
  });
});
