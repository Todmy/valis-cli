/**
 * Tests for `verify-prod-state.ts` exported check helpers.
 *
 * The script is operator-facing — a one-shot post-deploy verification run.
 * Tests target the HTTP-probe helpers (mockable via injected `fetch`) and
 * the Qdrant index helper (delegates to the already-tested
 * `ensureStructuredFilterIndexes`).
 *
 * Postgres schema check is intentionally NOT unit-tested — mocking the pg
 * Client adds disproportionate surface for marginal coverage; the schema
 * check is a 12-line read query that fails loud on first prod run.
 */

import { describe, it, expect } from 'vitest';
import {
  checkOAuthMetadata,
  checkApiCheckProbe,
  checkPostHogEvents,
} from '../../scripts/verify-prod-state.js';

function makeFetchResponder(handlers: Array<(req: Request) => Response | Promise<Response>>) {
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

describe('checkOAuthMetadata', () => {
  it('passes when the endpoint returns issuer + authorization_endpoint', async () => {
    const fetchImpl = makeFetchResponder([
      () =>
        jsonResponse({
          issuer: 'https://valis.krukit.co',
          authorization_endpoint: 'https://valis.krukit.co/oauth/authorize',
        }),
    ]);
    await expect(
      checkOAuthMetadata('https://valis.krukit.co', fetchImpl),
    ).resolves.toBeUndefined();
  });

  it('fails when the endpoint returns non-2xx', async () => {
    const fetchImpl = makeFetchResponder([
      () => new Response('not found', { status: 404 }),
    ]);
    await expect(
      checkOAuthMetadata('https://valis.krukit.co', fetchImpl),
    ).rejects.toThrow(/404/);
  });

  it('fails when the response is missing required fields', async () => {
    const fetchImpl = makeFetchResponder([
      () => jsonResponse({ issuer: 'https://x' }), // no authorization_endpoint
    ]);
    await expect(
      checkOAuthMetadata('https://x', fetchImpl),
    ).rejects.toThrow(/missing issuer\/authorization_endpoint/);
  });
});

describe('checkApiCheckProbe', () => {
  it('passes when /api/check returns 200 with violations array', async () => {
    const fetchImpl = makeFetchResponder([
      () => jsonResponse({ violations: [], decisions_evaluated: 0 }),
    ]);
    await expect(
      checkApiCheckProbe('https://valis.krukit.co', 'tok', fetchImpl),
    ).resolves.toBeUndefined();
  });

  it('fails when /api/check returns non-2xx', async () => {
    const fetchImpl = makeFetchResponder([
      () => new Response('rate limited', { status: 429 }),
    ]);
    await expect(
      checkApiCheckProbe('https://valis.krukit.co', 'tok', fetchImpl),
    ).rejects.toThrow(/429/);
  });

  it('fails when /api/check returns 200 but malformed shape', async () => {
    const fetchImpl = makeFetchResponder([
      () => jsonResponse({ unrelated_field: 'oops' }),
    ]);
    await expect(
      checkApiCheckProbe('https://valis.krukit.co', 'tok', fetchImpl),
    ).rejects.toThrow(/violations array/);
  });

  it('sends a Bearer Authorization header derived from the token', async () => {
    let seenAuth = '';
    const fetchImpl = makeFetchResponder([
      (req) => {
        seenAuth = req.headers.get('authorization') ?? '';
        return jsonResponse({ violations: [] });
      },
    ]);
    await checkApiCheckProbe('https://valis.krukit.co', 'secret-token', fetchImpl);
    expect(seenAuth).toBe('Bearer secret-token');
  });
});

describe('checkPostHogEvents', () => {
  it('passes when PostHog returns at least one event in the last hour', async () => {
    const fetchImpl = makeFetchResponder([
      () =>
        jsonResponse({
          results: [{ event: 'first_decision_captured', timestamp: '2026-05-15T10:00:00Z' }],
        }),
    ]);
    await expect(
      checkPostHogEvents('https://eu.posthog.com', 'phc_test', fetchImpl),
    ).resolves.toBeUndefined();
  });

  it('fails when the response is empty (no events fired)', async () => {
    const fetchImpl = makeFetchResponder([
      () => jsonResponse({ results: [] }),
    ]);
    await expect(
      checkPostHogEvents('https://eu.posthog.com', 'phc_test', fetchImpl),
    ).rejects.toThrow(/zero first_decision_captured events/);
  });

  it('fails with a clear message when the API rejects the key', async () => {
    const fetchImpl = makeFetchResponder([
      () => new Response('forbidden', { status: 403 }),
    ]);
    await expect(
      checkPostHogEvents('https://eu.posthog.com', 'phc_wrong', fetchImpl),
    ).rejects.toThrow(/403.*read key/);
  });

  it('uses the `after` query param to scope the window to one hour', async () => {
    let seenAfter: string | null = null;
    const fetchImpl = makeFetchResponder([
      (req) => {
        seenAfter = new URL(req.url).searchParams.get('after');
        return jsonResponse({ results: [{ event: 'first_decision_captured' }] });
      },
    ]);
    const before = Date.now();
    await checkPostHogEvents('https://eu.posthog.com', 'phc', fetchImpl);
    expect(seenAfter).toBeTruthy();
    const afterMs = Date.parse(seenAfter as unknown as string);
    // The `after` timestamp should be ~1h before the test invocation.
    expect(afterMs).toBeGreaterThanOrEqual(before - 60 * 60 * 1000 - 1000);
    expect(afterMs).toBeLessThanOrEqual(before - 60 * 60 * 1000 + 1000);
  });
});
