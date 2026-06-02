import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { augment, DEFAULT_TIMEOUT_MS } from '../../src/hooks/augment.js';

describe('hooks/augment — backend wiring', () => {
  const fetchMock = vi.fn();
  let prevFetch: typeof globalThis.fetch | undefined;

  beforeEach(() => {
    fetchMock.mockReset();
    prevFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
  });

  afterEach(() => {
    if (prevFetch) globalThis.fetch = prevFetch;
  });

  function ok(results: unknown[]) {
    return {
      ok: true,
      json: async () => ({ results }),
    } as Response;
  }

  it('returns served block when above-threshold results fit budget', async () => {
    fetchMock.mockResolvedValueOnce(
      ok([
        { id: 'a', summary: 'top hit', type: 'decision', score: 0.91 },
        { id: 'b', summary: 'next hit', type: 'pattern', score: 0.78 },
      ]),
    );
    const out = await augment('how do we cache decisions?', {
      apiBaseUrl: 'http://test',
      apiKey: 'k',
      projectId: 'p',
    });
    expect(out.reason).toBe('served');
    expect(out.block).not.toBeNull();
    expect(out.block!).toContain('id="a"');
    expect(out.block!).toContain('id="b"');
  });

  it('reports all_below_threshold when no result clears the bar', async () => {
    fetchMock.mockResolvedValueOnce(
      ok([{ id: 'a', summary: 'low', type: 'decision', score: 0.1 }]),
    );
    const out = await augment('hello', {
      apiBaseUrl: 'http://t',
      apiKey: 'k',
      projectId: 'p',
      threshold: 0.5,
    });
    expect(out.reason).toBe('all_below_threshold');
    expect(out.block).toBeNull();
  });

  it('reports no_results when backend returns empty', async () => {
    fetchMock.mockResolvedValueOnce(ok([]));
    const out = await augment('whatever', {
      apiBaseUrl: 'http://t',
      apiKey: 'k',
      projectId: 'p',
    });
    expect(out.reason).toBe('no_results');
    expect(out.block).toBeNull();
  });

  it('reports all_over_budget when results pass threshold but exceed cap', async () => {
    fetchMock.mockResolvedValueOnce(
      ok([
        { id: 'big', summary: 'X'.repeat(2000), type: 'decision', score: 0.9 },
      ]),
    );
    const out = await augment('q', {
      apiBaseUrl: 'http://t',
      apiKey: 'k',
      projectId: 'p',
      budgetTokens: 50,
    });
    expect(out.reason).toBe('all_over_budget');
    expect(out.block).toBeNull();
  });

  it('reports timeout when AbortController fires', async () => {
    fetchMock.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          // Simulate the timeoutMs path via DOMException.
          setTimeout(() => {
            const err = new Error('aborted');
            (err as { name: string }).name = 'AbortError';
            reject(err);
          }, 10);
        }),
    );
    const out = await augment('q', {
      apiBaseUrl: 'http://t',
      apiKey: 'k',
      projectId: 'p',
      timeoutMs: 5,
    });
    expect(out.reason).toBe('timeout');
    expect(out.block).toBeNull();
  });

  it('handles non-engineering Cyrillic prompts identically (no language gate)', async () => {
    fetchMock.mockResolvedValueOnce(
      ok([
        {
          id: 'p',
          summary: 'how the brand voice handles renewal emails',
          type: 'pattern',
          score: 0.82,
        },
      ]),
    );
    const out = await augment('Як ми пишемо листи про продовження?', {
      apiBaseUrl: 'http://t',
      apiKey: 'k',
      projectId: 'p',
    });
    expect(out.reason).toBe('served');
    expect(out.block).not.toBeNull();
  });

  // #242 — read-hook hot-path retune. The hook consumes only summaries, so it
  // asks the backend to skip server-side enrichment (sibling scroll, violation
  // counters, proposed-pending) that it would otherwise compute and discard.
  it('requests the lightweight enrich:false path (#242)', async () => {
    fetchMock.mockResolvedValueOnce(
      ok([{ id: 'a', summary: 's', type: 'decision', score: 0.9 }]),
    );
    await augment('q', { apiBaseUrl: 'http://t', apiKey: 'k', projectId: 'p' });
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const sent = JSON.parse(init.body as string);
    expect(sent.enrich).toBe(false);
  });

  // #242 — the 1500ms default left ~86% of live searches timing out (p50 hit
  // latency was 1409ms, right at the old ceiling). Retuned to 2500ms.
  it('defaults the backend timeout to 2500ms (#242)', () => {
    expect(DEFAULT_TIMEOUT_MS).toBe(2500);
  });
});

/**
 * FR-015 regression — the user-prompt path MUST NOT contain any keyword,
 * regex-trigger, or language-detection heuristic. The arena synthesis
 * showed that those gates are the failure mode the v2 design eliminates.
 *
 * This test enforces the "no heuristic gating" invariant by static-grep
 * against the source files of the always-inject path.
 */
describe('hooks/augment — FR-015 no-heuristic invariant (static grep)', () => {
  const cliRoot = resolve(__dirname, '..', '..', 'src', 'hooks');
  const sourceFiles = [
    'augment.ts',
    'user-prompt-submit-handler.ts',
    'inject-block.ts',
  ];

  // Words that indicate a keyword/intent gate. Comments are stripped before
  // matching so legitimate "no-heuristic" mentions in docstrings don't fail.
  const banned = [
    /\bkeyword(s|_list|_match|_trigger)?\b/i,
    /\btrigger_?list\b/i,
    /\bintent_?match(ing)?\b/i,
    /\blanguage_?detect/i,
    /\bregex_?trigger/i,
  ];

  function stripCommentsAndStrings(src: string): string {
    // Block comments
    let out = src.replace(/\/\*[\s\S]*?\*\//g, ' ');
    // Line comments
    out = out.replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    // Strip string literals (single, double, backtick) so banned tokens
    // inside log strings or doc text don't cause false positives.
    out = out.replace(/'(?:[^'\\]|\\.)*'/g, "''");
    out = out.replace(/"(?:[^"\\]|\\.)*"/g, '""');
    out = out.replace(/`(?:[^`\\]|\\.)*`/g, '``');
    return out;
  }

  for (const file of sourceFiles) {
    it(`${file} contains no keyword/trigger/intent gate`, () => {
      const path = join(cliRoot, file);
      const code = stripCommentsAndStrings(readFileSync(path, 'utf-8'));
      for (const pattern of banned) {
        expect(code, `pattern ${pattern} should not appear in ${file}`).not.toMatch(pattern);
      }
    });
  }

  it('hooks directory contains no trigger-list constant file', () => {
    const entries = readdirSync(cliRoot);
    for (const name of entries) {
      expect(name.toLowerCase()).not.toMatch(/trigger|keyword|intent/);
    }
  });
});
