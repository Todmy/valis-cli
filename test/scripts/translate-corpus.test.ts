/**
 * Tests for `translate-corpus.ts` exported helpers.
 *
 * The deep module `translateCorpus` is already covered in
 * `src/benchmarks/__tests__/corpus-translator.test.ts`. These tests target
 * the script-specific surface: corpus parsing (comment-tolerant) and the
 * DeepL HTTP adapter (mockable via injected `fetch`).
 *
 * main() is not unit-tested — it's a thin orchestrator. Coverage comes
 * from `parseCorpusBody` + `createDeepLApi` + the deep module's tests.
 */

import { describe, it, expect } from 'vitest';
import {
  createDeepLApi,
  parseCorpusBody,
} from '../../scripts/translate-corpus.js';

function makeFetchResponder(
  handlers: Array<(req: Request) => Response | Promise<Response>>,
) {
  let callIndex = 0;
  return (async (input: string | Request, init?: RequestInit) => {
    const request = new Request(input as string, init);
    const handler = handlers[callIndex++];
    if (!handler) throw new Error(`unexpected fetch call #${callIndex}`);
    return handler(request);
  }) as unknown as typeof fetch;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('parseCorpusBody', () => {
  it('skips # comment lines', () => {
    const raw = [
      '# header line 1',
      '# header line 2',
      '{"document":{"id":"a","text":"hello"}}',
    ].join('\n');
    const records = parseCorpusBody(raw);
    expect(records).toHaveLength(1);
    expect(records[0].document?.id).toBe('a');
  });

  it('skips blank lines', () => {
    const raw = [
      '',
      '{"document":{"id":"a","text":"hello"}}',
      '',
      '{"query":{"id":"q","text":"world"}}',
      '',
    ].join('\n');
    expect(parseCorpusBody(raw)).toHaveLength(2);
  });

  it('handles mixed comments + blank lines + body', () => {
    const raw = [
      '# Valis multilingual benchmark seed — EN slice.',
      '# Apache-2.0',
      '',
      '{"document":{"id":"d1","text":"x"}}',
      '{"document":{"id":"d2","text":"y"}}',
      '',
      '{"query":{"id":"q1","text":"z"},"ground_truth":{"query_id":"q1","relevant_doc_ids":["d1"]}}',
    ].join('\n');
    const records = parseCorpusBody(raw);
    expect(records).toHaveLength(3);
    expect(records[2].ground_truth?.query_id).toBe('q1');
  });

  it('throws on invalid JSON body line', () => {
    const raw = ['# ok', '{not-json}'].join('\n');
    expect(() => parseCorpusBody(raw)).toThrow();
  });

  it('returns empty array for header-only input', () => {
    const raw = ['# all comments', '# no body'].join('\n');
    expect(parseCorpusBody(raw)).toEqual([]);
  });
});

describe('createDeepLApi', () => {
  it('sends DeepL-Auth-Key header derived from the api key', async () => {
    let seenAuth = '';
    const fetchImpl = makeFetchResponder([
      (req) => {
        seenAuth = req.headers.get('authorization') ?? '';
        return jsonResponse({ translations: [{ text: 'привіт' }] });
      },
    ]);
    const api = createDeepLApi('secret-key', fetchImpl, 'https://test/translate');
    await api.translate(['hello'], 'uk');
    expect(seenAuth).toBe('DeepL-Auth-Key secret-key');
  });

  it('sends one `text` param per chunk and uppercased target_lang', async () => {
    let seenBody = '';
    const fetchImpl = makeFetchResponder([
      async (req) => {
        seenBody = await req.text();
        return jsonResponse({
          translations: [{ text: 'a' }, { text: 'b' }, { text: 'c' }],
        });
      },
    ]);
    const api = createDeepLApi('k', fetchImpl, 'https://test/translate');
    await api.translate(['one', 'two', 'three'], 'pl');

    const params = new URLSearchParams(seenBody);
    expect(params.getAll('text')).toEqual(['one', 'two', 'three']);
    expect(params.get('source_lang')).toBe('EN');
    expect(params.get('target_lang')).toBe('PL');
  });

  it('returns translations in the same order DeepL replies', async () => {
    const fetchImpl = makeFetchResponder([
      () =>
        jsonResponse({
          translations: [
            { text: 'один' },
            { text: 'два' },
            { text: 'три' },
          ],
        }),
    ]);
    const api = createDeepLApi('k', fetchImpl, 'https://test/translate');
    const out = await api.translate(['one', 'two', 'three'], 'uk');
    expect(out).toEqual(['один', 'два', 'три']);
  });

  it('throws an error with status field set on non-2xx', async () => {
    const fetchImpl = makeFetchResponder([
      () => new Response('rate limited', { status: 429 }),
    ]);
    const api = createDeepLApi('k', fetchImpl, 'https://test/translate');
    try {
      await api.translate(['x'], 'uk');
      throw new Error('expected throw');
    } catch (err) {
      expect((err as Error).message).toMatch(/DeepL 429/);
      expect((err as Error & { status: number }).status).toBe(429);
    }
  });

  it('truncates very long error bodies to 200 chars in the message', async () => {
    const longBody = 'x'.repeat(500);
    const fetchImpl = makeFetchResponder([
      () => new Response(longBody, { status: 403 }),
    ]);
    const api = createDeepLApi('k', fetchImpl, 'https://test/translate');
    try {
      await api.translate(['x'], 'uk');
      throw new Error('expected throw');
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg.length).toBeLessThan(250);
      expect(msg).toMatch(/DeepL 403/);
    }
  });

  it('hits the custom endpoint when supplied', async () => {
    let seenUrl = '';
    const fetchImpl = makeFetchResponder([
      (req) => {
        seenUrl = req.url;
        return jsonResponse({ translations: [{ text: 'ok' }] });
      },
    ]);
    const api = createDeepLApi('k', fetchImpl, 'https://custom.deepl/v2/translate');
    await api.translate(['x'], 'uk');
    expect(seenUrl).toBe('https://custom.deepl/v2/translate');
  });
});
