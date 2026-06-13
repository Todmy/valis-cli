/**
 * 285/T002: raw-fetch AI Gateway client, provider-pinned, failover OFF.
 *
 * Pattern: raw `fetch()` + `AbortController` (mirrors
 * packages/cli/src/contradiction/classify.ts:95-110). No AI SDK in the CLI.
 *
 * Provider pinning / NO failover is the whole point of this client.
 * Lesson d8116b79 (2026-06-04): with `providerOptions.gateway.order:
 * ['anthropic','bedrock']`, the IDENTICAL prompt at temperature:0 can route to
 * a different inference backend (Anthropic Haiku vs Bedrock Haiku) and re-roll
 * its output — temp:0 controls sampling within ONE backend, not cross-backend
 * agreement. An eval/optimizer harness MUST hold the backend fixed across the
 * K=5 variance-band repeats or the band is meaningless. So we send a single
 * provider in `providerOptions.gateway.order` with NO fallback entry — the
 * inverse of llm.ts:191's `order:['anthropic','bedrock']`.
 */

import { costUsd, gatewaySlug, type ModelSlug } from './pricing.js';

const DEFAULT_BASE_URL = 'https://ai-gateway.vercel.sh/v1';
const DEFAULT_TIMEOUT_MS = 60_000;

export interface GatewayMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface GatewayRequest {
  model: ModelSlug;
  system: string;
  messages: GatewayMessage[];
  maxTokens: number;
  temperature: number;
  /** Bearer token. Defaults to `AI_GATEWAY_API_KEY` from env. */
  apiKey?: string;
  /** Per-call hard timeout. Default 60s. */
  timeoutMs?: number;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

export interface GatewayResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  costUsd: number;
}

/** Typed fail-loud error — every non-success path throws this (never silent). */
export class GatewayError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    options?: { cause?: unknown },
  ) {
    super(message);
    this.name = 'GatewayError';
    if (options?.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string } }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  };
}

export async function callGateway(req: GatewayRequest): Promise<GatewayResult> {
  const apiKey = req.apiKey ?? process.env.AI_GATEWAY_API_KEY;
  if (!apiKey) {
    throw new GatewayError('missing AI_GATEWAY_API_KEY');
  }
  const baseUrl = process.env.AI_GATEWAY_BASE_URL ?? DEFAULT_BASE_URL;
  const fetchImpl = req.fetchImpl ?? fetch;
  const timeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetchImpl(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: gatewaySlug(req.model),
        max_tokens: req.maxTokens,
        temperature: req.temperature,
        messages: [
          { role: 'system', content: req.system },
          ...req.messages,
        ],
        // Provider pinning, failover OFF (see module header + lesson d8116b79):
        // a single provider, NO fallback entry — inverse of llm.ts:191's
        // order:['anthropic','bedrock'].
        providerOptions: {
          gateway: { order: ['anthropic'] },
        },
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      let detail = '';
      try {
        detail = await res.text();
      } catch {
        /* ignore */
      }
      throw new GatewayError(
        `gateway ${res.status}: ${detail.slice(0, 500)}`,
        res.status,
      );
    }

    const data = (await res.json()) as ChatCompletionResponse;
    const text = data.choices?.[0]?.message?.content ?? '';
    const promptTokens = data.usage?.prompt_tokens ?? 0;
    const outputTokens = data.usage?.completion_tokens ?? 0;
    const cachedInputTokens = data.usage?.prompt_tokens_details?.cached_tokens ?? 0;
    // `prompt_tokens` is the TOTAL prompt count (cached included); fresh input
    // is the remainder billed at the full rate.
    const freshInputTokens = Math.max(0, promptTokens - cachedInputTokens);

    return {
      text,
      inputTokens: freshInputTokens,
      outputTokens,
      cachedInputTokens,
      costUsd: costUsd(req.model, freshInputTokens, outputTokens, cachedInputTokens),
    };
  } catch (err) {
    if (err instanceof GatewayError) throw err;
    if (err instanceof Error && err.name === 'AbortError') {
      throw new GatewayError(`gateway timeout after ${timeoutMs}ms`, undefined, {
        cause: err,
      });
    }
    throw new GatewayError(
      err instanceof Error ? err.message : 'gateway request failed',
      undefined,
      { cause: err },
    );
  } finally {
    clearTimeout(timer);
  }
}
