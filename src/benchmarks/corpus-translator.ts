/**
 * 021/Track 7 — Multilingual benchmark slice generator.
 *
 * Wraps a translation provider (DeepL by default) to convert an EN seed
 * corpus into UA + PL slices. The deep module:
 *
 *   - Iterates only over text-bearing fields (Document.text, Query.text).
 *     IDs, ground_truth references, metadata, and language tags are
 *     copy-through so the slice keeps strict 1:1 alignment with the seed.
 *
 *   - Chunks paragraph-by-paragraph against the provider's per-request char
 *     limit (DeepL: 5K). Output reassembles on the same separator so
 *     translations preserve structural intent.
 *
 *   - Backs off exponentially on 429 (rate-limit) responses up to a
 *     configurable retry cap; other 4xx surface immediately.
 *
 *   - Records a per-line provenance trail: `metadata.translation` carries
 *     `{ source_id, source_lang, target_lang, provider, content_hash }`
 *     so future reproducibility can verify the slice matches the seed.
 *
 * Provider abstracted as `TranslationApi` so unit tests can pass a
 * deterministic stub.
 */

import { createHash } from 'node:crypto';

export type TargetLanguage = 'uk' | 'pl';

export interface TranslationApi {
  /**
   * Translate one or more chunks of text from EN to `target`. Returns one
   * output per input in the same order. Implementations should respect the
   * provider's per-request limits; the caller never sends a single chunk
   * over the limit.
   */
  translate(chunks: string[], target: TargetLanguage): Promise<string[]>;
}

export interface CorpusLineRecord {
  document?: {
    id: string;
    text: string;
    language?: string;
    metadata?: Record<string, unknown>;
  };
  query?: {
    id: string;
    text: string;
    language?: string;
    metadata?: Record<string, unknown>;
  };
  ground_truth?: {
    query_id: string;
    relevant_doc_ids: string[];
  };
}

export interface TranslateCorpusOptions {
  /** Override per-request char limit (default: 4500 to leave DeepL margin). */
  chunkLimit?: number;
  /** Override max retries on 429 (default: 4 → ~30s exp backoff). */
  maxRetries?: number;
  /** Override base backoff delay in ms (default: 500 → 500/1000/2000/4000). */
  baseDelayMs?: number;
  /** Test seam: override sleep so unit tests don't burn real time. */
  sleep?: (ms: number) => Promise<void>;
  /** Provider tag persisted in provenance metadata (default: 'deepl'). */
  providerTag?: string;
}

const DEFAULT_CHUNK_LIMIT = 4500;
const DEFAULT_MAX_RETRIES = 4;
const DEFAULT_BASE_DELAY = 500;

/**
 * Treat any value that looks like a 429 as retryable. The provider may
 * surface this as a thrown error, a `.status` property, or an HTTP code
 * embedded in the message. Strict 429 detection: be lenient on shape.
 */
function isRateLimit(err: unknown): boolean {
  if (err instanceof Error) {
    if (/429|rate.?limit|too.?many/i.test(err.message)) return true;
    if (typeof (err as { status?: number }).status === 'number') {
      return (err as { status?: number }).status === 429;
    }
  }
  return false;
}

async function callWithBackoff(
  api: TranslationApi,
  chunks: string[],
  target: TargetLanguage,
  opts: Required<
    Pick<TranslateCorpusOptions, 'maxRetries' | 'baseDelayMs' | 'sleep'>
  >,
): Promise<string[]> {
  let attempt = 0;
  while (true) {
    try {
      return await api.translate(chunks, target);
    } catch (err) {
      if (!isRateLimit(err) || attempt >= opts.maxRetries) throw err;
      const delay = opts.baseDelayMs * Math.pow(2, attempt);
      await opts.sleep(delay);
      attempt += 1;
    }
  }
}

/**
 * Split `text` into chunks that each fit under `limit`. Splits on `\n\n`
 * paragraph boundaries first; if a single paragraph is over the limit,
 * falls back to greedy character-based split (paragraph longer than
 * `limit` is rare for corpus content but the fallback keeps the contract
 * total).
 */
export function splitForTranslation(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];
  const paragraphs = text.split('\n\n');
  const chunks: string[] = [];
  let current = '';
  for (const para of paragraphs) {
    const candidate = current ? `${current}\n\n${para}` : para;
    if (candidate.length <= limit) {
      current = candidate;
      continue;
    }
    if (current) chunks.push(current);
    if (para.length <= limit) {
      current = para;
    } else {
      // Single paragraph over the limit — character-greedy split.
      let remaining = para;
      while (remaining.length > limit) {
        chunks.push(remaining.slice(0, limit));
        remaining = remaining.slice(limit);
      }
      current = remaining;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

async function translateField(
  api: TranslationApi,
  text: string,
  target: TargetLanguage,
  opts: Required<
    Pick<TranslateCorpusOptions, 'chunkLimit' | 'maxRetries' | 'baseDelayMs' | 'sleep'>
  >,
): Promise<string> {
  const chunks = splitForTranslation(text, opts.chunkLimit);
  const translated = await callWithBackoff(api, chunks, target, {
    maxRetries: opts.maxRetries,
    baseDelayMs: opts.baseDelayMs,
    sleep: opts.sleep,
  });
  if (translated.length !== chunks.length) {
    throw new Error(
      `translation provider returned ${translated.length} chunks for ${chunks.length} inputs`,
    );
  }
  return translated.join('\n\n');
}

function contentHash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

function attachProvenance(
  meta: Record<string, unknown> | undefined,
  sourceId: string,
  target: TargetLanguage,
  sourceText: string,
  providerTag: string,
): Record<string, unknown> {
  return {
    ...(meta ?? {}),
    translation: {
      source_id: sourceId,
      source_lang: 'en',
      target_lang: target,
      provider: providerTag,
      content_hash: contentHash(sourceText),
    },
  };
}

/**
 * Translate every text-bearing field of an EN corpus into `target`. IDs,
 * ground_truth references, and non-text metadata are copy-through —
 * preserves referential integrity with the seed slice.
 *
 * Throws on translation-provider failure that exhausted retries; callers
 * decide whether to retry the whole run or fail the bench. The function
 * never partially mutates: it builds the new corpus in memory and returns
 * it as a complete array, so a failed call leaves the seed untouched.
 */
export async function translateCorpus(
  seed: CorpusLineRecord[],
  target: TargetLanguage,
  api: TranslationApi,
  options: TranslateCorpusOptions = {},
): Promise<CorpusLineRecord[]> {
  const opts = {
    chunkLimit: options.chunkLimit ?? DEFAULT_CHUNK_LIMIT,
    maxRetries: options.maxRetries ?? DEFAULT_MAX_RETRIES,
    baseDelayMs: options.baseDelayMs ?? DEFAULT_BASE_DELAY,
    sleep:
      options.sleep ??
      ((ms: number) => new Promise<void>((r) => setTimeout(r, ms))),
    providerTag: options.providerTag ?? 'deepl',
  };

  const out: CorpusLineRecord[] = [];
  for (const line of seed) {
    const result: CorpusLineRecord = {};

    if (line.document) {
      const translated = await translateField(api, line.document.text, target, opts);
      result.document = {
        id: line.document.id,
        text: translated,
        language: target,
        metadata: attachProvenance(
          line.document.metadata,
          line.document.id,
          target,
          line.document.text,
          opts.providerTag,
        ),
      };
    }

    if (line.query) {
      const translated = await translateField(api, line.query.text, target, opts);
      result.query = {
        id: line.query.id,
        text: translated,
        language: target,
        metadata: attachProvenance(
          line.query.metadata,
          line.query.id,
          target,
          line.query.text,
          opts.providerTag,
        ),
      };
    }

    if (line.ground_truth) {
      // Ground truth is structural — IDs only, no text to translate.
      result.ground_truth = {
        query_id: line.ground_truth.query_id,
        relevant_doc_ids: [...line.ground_truth.relevant_doc_ids],
      };
    }

    out.push(result);
  }

  return out;
}
