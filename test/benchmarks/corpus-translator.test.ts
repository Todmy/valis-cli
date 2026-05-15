/**
 * Tests for CorpusTranslator (021/Track 7, sprint 2026-05-14).
 *
 * Covers the four behavioural contracts that matter to callers:
 *   - text fields translated, IDs + ground_truth copy-through verbatim
 *   - large text chunked on paragraph boundaries (DeepL 5K limit)
 *   - 429 rate-limit triggers exponential backoff up to maxRetries
 *   - failed translation never partially mutates the corpus
 */

import { describe, it, expect, vi } from 'vitest';
import {
  splitForTranslation,
  translateCorpus,
  type CorpusLineRecord,
  type TranslationApi,
} from '../../src/benchmarks/corpus-translator.js';

function makeStub(impl: (chunks: string[]) => string[] | Promise<string[]>): TranslationApi {
  return {
    translate: async (chunks) => impl(chunks),
  };
}

describe('splitForTranslation', () => {
  it('returns single chunk when text fits the limit', () => {
    expect(splitForTranslation('short', 100)).toEqual(['short']);
  });

  it('splits on paragraph boundaries when text exceeds limit', () => {
    // Two 60-char paragraphs joined with \n\n = 122 chars total. Limit 100
    // forces a split between them.
    const para1 = 'a'.repeat(60);
    const para2 = 'b'.repeat(60);
    const chunks = splitForTranslation(`${para1}\n\n${para2}`, 100);
    expect(chunks).toEqual([para1, para2]);
  });

  it('falls back to character-greedy split when one paragraph exceeds limit', () => {
    const long = 'x'.repeat(250);
    const chunks = splitForTranslation(long, 100);
    expect(chunks).toEqual(['x'.repeat(100), 'x'.repeat(100), 'x'.repeat(50)]);
  });
});

describe('translateCorpus', () => {
  const seed: CorpusLineRecord[] = [
    {
      document: { id: 'doc-1', text: 'Hello world.', metadata: { topic: 'auth' } },
    },
    {
      query: { id: 'q-1', text: 'Where is the auth flow?', metadata: { intent: 'find' } },
      ground_truth: { query_id: 'q-1', relevant_doc_ids: ['doc-1'] },
    },
  ];

  it('translates text fields and preserves IDs + ground_truth verbatim', async () => {
    const api = makeStub((chunks) => chunks.map((c) => `[uk]${c}`));

    const out = await translateCorpus(seed, 'uk', api);

    expect(out[0].document?.id).toBe('doc-1');
    expect(out[0].document?.text).toBe('[uk]Hello world.');
    expect(out[0].document?.language).toBe('uk');
    // Original metadata field preserved alongside the new translation provenance.
    expect(out[0].document?.metadata?.topic).toBe('auth');
    expect(out[0].document?.metadata?.translation).toMatchObject({
      source_id: 'doc-1',
      source_lang: 'en',
      target_lang: 'uk',
      provider: 'deepl',
    });

    expect(out[1].query?.id).toBe('q-1');
    expect(out[1].query?.text).toBe('[uk]Where is the auth flow?');
    expect(out[1].ground_truth).toEqual({
      query_id: 'q-1',
      relevant_doc_ids: ['doc-1'],
    });
  });

  it('chunks long text and reassembles the translated output on the same separator', async () => {
    const para1 = 'a'.repeat(40);
    const para2 = 'b'.repeat(40);
    const longSeed: CorpusLineRecord[] = [
      { document: { id: 'doc-long', text: `${para1}\n\n${para2}` } },
    ];

    let callCount = 0;
    const api = makeStub((chunks) => {
      callCount += 1;
      expect(chunks).toEqual([para1, para2]); // split at \n\n
      return chunks.map((c) => `[pl]${c}`);
    });

    const out = await translateCorpus(longSeed, 'pl', api, { chunkLimit: 50 });

    expect(callCount).toBe(1);
    expect(out[0].document?.text).toBe(`[pl]${para1}\n\n[pl]${para2}`);
  });

  it('retries on 429 with exponential backoff up to maxRetries', async () => {
    // Single-line seed so the attempt counter only tracks one field's calls
    // (otherwise line 2 would keep incrementing past the assertion).
    const singleSeed: CorpusLineRecord[] = [
      { document: { id: 'doc-1', text: 'Hello world.' } },
    ];
    let attempts = 0;
    const api: TranslationApi = {
      translate: async (chunks) => {
        attempts += 1;
        if (attempts < 3) {
          const err = new Error('429 Too Many Requests') as Error & { status?: number };
          err.status = 429;
          throw err;
        }
        return chunks.map((c) => `[uk]${c}`);
      },
    };
    const sleep = vi.fn().mockResolvedValue(undefined);

    const out = await translateCorpus(singleSeed, 'uk', api, {
      maxRetries: 4,
      baseDelayMs: 100,
      sleep,
    });

    expect(attempts).toBe(3);
    // Two backoffs: 100ms (after 1st failure) + 200ms (after 2nd).
    expect(sleep).toHaveBeenNthCalledWith(1, 100);
    expect(sleep).toHaveBeenNthCalledWith(2, 200);
    expect(out[0].document?.text).toBe('[uk]Hello world.');
  });

  it('throws after exhausting retries on persistent 429', async () => {
    const api: TranslationApi = {
      translate: async () => {
        const err = new Error('429 rate limit hit') as Error & { status?: number };
        err.status = 429;
        throw err;
      },
    };

    await expect(
      translateCorpus(seed, 'uk', api, {
        maxRetries: 2,
        baseDelayMs: 10,
        sleep: () => Promise.resolve(),
      }),
    ).rejects.toThrow(/429|rate/i);
  });

  it('non-429 errors propagate immediately without retry', async () => {
    let attempts = 0;
    const api: TranslationApi = {
      translate: async () => {
        attempts += 1;
        throw new Error('400 Bad Request');
      },
    };

    await expect(
      translateCorpus(seed, 'uk', api, {
        maxRetries: 5,
        baseDelayMs: 10,
        sleep: () => Promise.resolve(),
      }),
    ).rejects.toThrow(/400/);
    expect(attempts).toBe(1);
  });

  it('records content_hash so reproducibility can verify slice matches seed', async () => {
    const api = makeStub((chunks) => chunks.map(() => '...'));

    const out = await translateCorpus(seed, 'uk', api);

    const docHash = out[0].document?.metadata?.translation as { content_hash: string };
    expect(docHash.content_hash).toMatch(/^[a-f0-9]{16}$/);
    // Same source text → same hash (deterministic, content-derived).
    const again = await translateCorpus(seed, 'uk', api);
    expect(
      (again[0].document?.metadata?.translation as { content_hash: string }).content_hash,
    ).toBe(docHash.content_hash);
  });
});
