import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  ServerInferenceStrategy,
  ClientEmbeddingStrategy,
  detectEmbeddingStrategy,
  _resetStrategyCache,
  truncateForEmbedding,
  parseQuotaError,
  EmbeddingQuotaError,
  DENSE_MODEL,
  BM25_MODEL,
  DENSE_VECTOR_NAME,
  BM25_VECTOR_NAME,
  VECTOR_SIZE,
  MAX_EMBEDDING_INPUT_CHARS,
  PROBE_POINT_ID,
} from '../../src/cloud/embedding.js';

// ---------------------------------------------------------------------------
// 1–4. ServerInferenceStrategy
// ---------------------------------------------------------------------------

describe('ServerInferenceStrategy', () => {
  const strategy = new ServerInferenceStrategy();

  it('case 1: mode is "server" and supportsHybrid is true', () => {
    expect(strategy.mode).toBe('server');
    expect(strategy.supportsHybrid).toBe(true);
  });

  it('case 2: vectorForUpsert returns named-vectors map with Document shapes', () => {
    const result = strategy.vectorForUpsert('hello world');
    expect(result).toEqual({
      [DENSE_VECTOR_NAME]: { text: 'hello world', model: DENSE_MODEL },
      [BM25_VECTOR_NAME]: { text: 'hello world', model: BM25_MODEL },
    });
  });

  it('case 3: queryForDense returns Document with DENSE_MODEL', () => {
    const result = strategy.queryForDense('search query');
    expect(result).toEqual({ text: 'search query', model: DENSE_MODEL });
  });

  it('case 4: queryForSparse returns Document with BM25_MODEL', () => {
    const result = strategy.queryForSparse('search query');
    expect(result).toEqual({ text: 'search query', model: BM25_MODEL });
  });
});

// ---------------------------------------------------------------------------
// 5–8. ClientEmbeddingStrategy
// ---------------------------------------------------------------------------

/**
 * Test subclass that overrides `_embed` so unit tests do not load the real
 * fastembed ONNX runtime. Returns a deterministic VECTOR_SIZE-length vector.
 */
class StubClientStrategy extends ClientEmbeddingStrategy {
  protected async _embed(_text: string): Promise<number[]> {
    return Array.from({ length: VECTOR_SIZE }, (_, i) => i / VECTOR_SIZE);
  }
}

describe('ClientEmbeddingStrategy', () => {
  it('case 5: mode is "client", supportsHybrid is false, queryForSparse returns null', () => {
    const strategy = new StubClientStrategy();
    expect(strategy.mode).toBe('client');
    expect(strategy.supportsHybrid).toBe(false);
    expect(strategy.queryForSparse('any')).toBeNull();
  });

  it('case 6: vectorForUpsertAsync returns { "": number[VECTOR_SIZE] } (embed stubbed)', async () => {
    const strategy = new StubClientStrategy();
    const result = await strategy.vectorForUpsertAsync('decision text');
    expect(result).toHaveProperty(DENSE_VECTOR_NAME);
    const vec = (result as Record<string, number[]>)[DENSE_VECTOR_NAME];
    expect(Array.isArray(vec)).toBe(true);
    expect(vec).toHaveLength(VECTOR_SIZE);
  });

  it('case 7: queryForDenseAsync returns number[VECTOR_SIZE]', async () => {
    const strategy = new StubClientStrategy();
    const vec = await strategy.queryForDenseAsync('query');
    expect(Array.isArray(vec)).toBe(true);
    expect(vec).toHaveLength(VECTOR_SIZE);
  });

  it('case 8: sync vectorForUpsert throws with prescribed message', () => {
    const strategy = new StubClientStrategy();
    expect(() => strategy.vectorForUpsert('text')).toThrow(/async vectorForUpsertAsync/);
    expect(() => strategy.queryForDense('text')).toThrow(/async queryForDenseAsync/);
  });
});

// ---------------------------------------------------------------------------
// 9–13. detectEmbeddingStrategy
// ---------------------------------------------------------------------------

interface FakeQdrantClient {
  upsert: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
}

function makeFakeQdrant(opts: {
  upsertResolves?: boolean;
  upsertError?: unknown;
}): FakeQdrantClient {
  return {
    upsert: vi.fn(() =>
      opts.upsertResolves === false
        ? Promise.reject(opts.upsertError ?? new Error('inference unavailable'))
        : Promise.resolve({ status: 'ok' }),
    ),
    delete: vi.fn(() => Promise.resolve({ status: 'ok' })),
  };
}

describe('detectEmbeddingStrategy', () => {
  const originalEnv = process.env.QDRANT_EMBEDDING_STRATEGY;

  beforeEach(() => {
    _resetStrategyCache();
    delete process.env.QDRANT_EMBEDDING_STRATEGY;
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.QDRANT_EMBEDDING_STRATEGY;
    } else {
      process.env.QDRANT_EMBEDDING_STRATEGY = originalEnv;
    }
  });

  it('case 9: probe upsert succeeds → returns ServerInferenceStrategy', async () => {
    const fake = makeFakeQdrant({ upsertResolves: true });
    const strategy = await detectEmbeddingStrategy(
      fake as unknown as Parameters<typeof detectEmbeddingStrategy>[0],
      'decisions',
    );
    expect(strategy.mode).toBe('server');
    expect(fake.upsert).toHaveBeenCalledOnce();
    expect(fake.delete).toHaveBeenCalledOnce();
    // Probe used the fixed UUID and the synthetic org_id
    const upsertArgs = fake.upsert.mock.calls[0];
    const point = (upsertArgs[1] as { points: { id: string; payload: { org_id: string; __probe: boolean } }[] }).points[0];
    expect(point.id).toBe(PROBE_POINT_ID);
    expect(point.payload.org_id).toBe('__probe__');
    expect(point.payload.__probe).toBe(true);
  });

  it('case 10: probe upsert throws → returns ClientEmbeddingStrategy', async () => {
    const fake = makeFakeQdrant({ upsertResolves: false });
    const strategy = await detectEmbeddingStrategy(
      fake as unknown as Parameters<typeof detectEmbeddingStrategy>[0],
      'decisions',
    );
    expect(strategy.mode).toBe('client');
    expect(fake.delete).not.toHaveBeenCalled();
  });

  it('case 11: second call returns cached strategy without re-probing', async () => {
    const fake = makeFakeQdrant({ upsertResolves: true });
    const a = await detectEmbeddingStrategy(
      fake as unknown as Parameters<typeof detectEmbeddingStrategy>[0],
      'decisions',
    );
    const b = await detectEmbeddingStrategy(
      fake as unknown as Parameters<typeof detectEmbeddingStrategy>[0],
      'decisions',
    );
    expect(a).toBe(b);
    expect(fake.upsert).toHaveBeenCalledOnce();
  });

  it('case 12: QDRANT_EMBEDDING_STRATEGY=server forces server mode without probe', async () => {
    process.env.QDRANT_EMBEDDING_STRATEGY = 'server';
    const fake = makeFakeQdrant({ upsertResolves: false });
    const strategy = await detectEmbeddingStrategy(
      fake as unknown as Parameters<typeof detectEmbeddingStrategy>[0],
      'decisions',
    );
    expect(strategy.mode).toBe('server');
    expect(fake.upsert).not.toHaveBeenCalled();
  });

  it('case 13: QDRANT_EMBEDDING_STRATEGY=client forces client mode without probe', async () => {
    process.env.QDRANT_EMBEDDING_STRATEGY = 'client';
    const fake = makeFakeQdrant({ upsertResolves: true });
    const strategy = await detectEmbeddingStrategy(
      fake as unknown as Parameters<typeof detectEmbeddingStrategy>[0],
      'decisions',
    );
    expect(strategy.mode).toBe('client');
    expect(fake.upsert).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 14–16. parseQuotaError + EmbeddingQuotaError
// ---------------------------------------------------------------------------

describe('parseQuotaError', () => {
  it('case 14: HTTP 429 error → parsed EmbeddingQuotaError with correct mode', () => {
    const err = Object.assign(new Error('rate limit hit'), { status: 429 });
    const parsed = parseQuotaError(err, 'server');
    expect(parsed).toBeInstanceOf(EmbeddingQuotaError);
    expect(parsed!.code).toBe('embedding_quota_exhausted');
    expect(parsed!.strategyMode).toBe('server');
  });

  it('case 15: non-quota Error returns null', () => {
    const err = new Error('connection refused');
    expect(parseQuotaError(err, 'server')).toBeNull();
    expect(parseQuotaError('not even an error', 'client')).toBeNull();
  });

  it('case 16: quota error preserves original message in .message', () => {
    const err = new Error('Monthly token quota exceeded');
    const parsed = parseQuotaError(err, 'client');
    expect(parsed).not.toBeNull();
    expect(parsed!.message).toBe('Monthly token quota exceeded');
    expect(parsed!.strategyMode).toBe('client');
  });
});

// ---------------------------------------------------------------------------
// 17–18. truncateForEmbedding (FR-013b)
// ---------------------------------------------------------------------------

describe('truncateForEmbedding', () => {
  it('case 17: short text passes through unchanged', () => {
    const text = 'a quick decision';
    expect(truncateForEmbedding(text)).toBe(text);
  });

  it('case 18: long text is truncated to MAX_EMBEDDING_INPUT_CHARS and emits warn', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const long = 'x'.repeat(MAX_EMBEDDING_INPUT_CHARS + 500);
    const result = truncateForEmbedding(long);
    expect(result).toHaveLength(MAX_EMBEDDING_INPUT_CHARS);
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy.mock.calls[0][0]).toMatch(/truncated input from \d+ to 2000 chars/);
    warnSpy.mockRestore();
  });
});
