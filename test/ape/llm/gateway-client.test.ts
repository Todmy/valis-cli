/**
 * 285/T002: AI Gateway client contract.
 *
 * No live calls — a fake `fetchImpl` returns canned OpenAI-compatible responses.
 * Verifies provider pinning (failover OFF), usage+cost return, fail-loud on
 * non-2xx, and AbortController timeout.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  callGateway,
  GatewayError,
} from '../../../src/ape/llm/gateway-client.js';

/** A canned OpenAI-compatible chat-completions success body. */
function okBody(text: string, prompt = 100, completion = 20, cached = 0) {
  return {
    choices: [{ message: { role: 'assistant', content: text } }],
    usage: {
      prompt_tokens: prompt,
      completion_tokens: completion,
      prompt_tokens_details: { cached_tokens: cached },
    },
  };
}

function fakeFetch(body: unknown, init?: { ok?: boolean; status?: number }): typeof fetch {
  return (async () =>
    ({
      ok: init?.ok ?? true,
      status: init?.status ?? 200,
      json: async () => body,
      text: async () => JSON.stringify(body),
    }) as unknown as Response) as typeof fetch;
}

const baseReq = {
  model: 'anthropic/claude-haiku-4.5' as const,
  system: 'You are a worker.',
  messages: [{ role: 'user' as const, content: 'hi' }],
  maxTokens: 64,
  temperature: 0,
};

describe('callGateway — provider pinning', () => {
  it('pins provider and disables failover in request body', async () => {
    let captured: any;
    const fetchImpl = (async (_url: string, opts: RequestInit) => {
      captured = JSON.parse(opts.body as string);
      return {
        ok: true,
        status: 200,
        json: async () => okBody('ok'),
        text: async () => '',
      } as unknown as Response;
    }) as typeof fetch;

    await callGateway({ ...baseReq, apiKey: 'k', fetchImpl });

    // single provider, NO fallback list (the inverse of order:['anthropic','bedrock'])
    const order = captured?.providerOptions?.gateway?.order;
    expect(order).toEqual(['anthropic']);
    expect(captured.model).toBe('anthropic/claude-haiku-4.5');
    expect(captured.temperature).toBe(0);
    expect(captured.max_tokens).toBe(64);
  });

  it('sends Authorization bearer + targets the chat-completions endpoint', async () => {
    let url = '';
    let auth = '';
    const fetchImpl = (async (u: string, opts: RequestInit) => {
      url = u;
      auth = (opts.headers as Record<string, string>).Authorization;
      return {
        ok: true,
        status: 200,
        json: async () => okBody('ok'),
        text: async () => '',
      } as unknown as Response;
    }) as typeof fetch;

    await callGateway({ ...baseReq, apiKey: 'secret', fetchImpl });
    expect(url).toContain('/chat/completions');
    expect(auth).toBe('Bearer secret');
  });
});

describe('callGateway — usage + cost', () => {
  it('returns text, usage, and cost', async () => {
    const fetchImpl = fakeFetch(okBody('hello world', 1_000_000, 1_000_000, 0));
    const out = await callGateway({ ...baseReq, apiKey: 'k', fetchImpl });
    expect(out.text).toBe('hello world');
    expect(out.inputTokens).toBe(1_000_000);
    expect(out.outputTokens).toBe(1_000_000);
    expect(out.cachedInputTokens).toBe(0);
    // cost for haiku 1M in + 1M out = 1.0 + 5.0
    expect(out.costUsd).toBeCloseTo(6.0, 6);
  });

  it('attributes cached tokens to the cached rate', async () => {
    // 1M total prompt, 1M of which cached → fresh input = 0
    const fetchImpl = fakeFetch(okBody('x', 1_000_000, 0, 1_000_000));
    const out = await callGateway({ ...baseReq, apiKey: 'k', fetchImpl });
    expect(out.cachedInputTokens).toBe(1_000_000);
    // haiku cached read 0.1/M, no output → 0.1
    expect(out.costUsd).toBeCloseTo(0.1, 6);
  });
});

describe('callGateway — fail-loud', () => {
  it('throws GatewayError on 5xx', async () => {
    const fetchImpl = fakeFetch({ error: 'boom' }, { ok: false, status: 503 });
    await expect(callGateway({ ...baseReq, apiKey: 'k', fetchImpl })).rejects.toBeInstanceOf(
      GatewayError,
    );
  });

  it('respects AbortController timeout', async () => {
    vi.useFakeTimers();
    const fetchImpl = ((_url: string, opts: RequestInit) =>
      new Promise((_resolve, reject) => {
        const signal = opts.signal as AbortSignal;
        signal.addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      })) as typeof fetch;

    const p = callGateway({ ...baseReq, apiKey: 'k', timeoutMs: 50, fetchImpl });
    const assertion = expect(p).rejects.toBeInstanceOf(GatewayError);
    await vi.advanceTimersByTimeAsync(60);
    await assertion;
    vi.useRealTimers();
  });
});
