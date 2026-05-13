/**
 * 025/T008: LinkExtractor unit tests — FR-015 scenarios T-LE-001..008 from
 * `specs/025-depends-on-enrich/contracts/link-extractor.md`.
 *
 * Mock `SearchFn` so timings, similarity values, and error paths are fully
 * deterministic. The extractor's non-throw / timeout / clamp behaviour are
 * exactly the invariants the rollout depends on; we exercise each one.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  extractLinks,
  type SearchFn,
} from '../../../src/mcp/tools/link-extractor.js';

function fakeSearch(rows: Array<{ id: string; similarity: number }>): SearchFn {
  return async () => rows;
}

function neverResolves(): SearchFn {
  return () => new Promise(() => {
    /* never */
  });
}

describe('extractLinks — T-LE-001 top-3 all above threshold', () => {
  it('chooses all three candidates and reports status ok', async () => {
    const search = fakeSearch([
      { id: 'a', similarity: 0.7 },
      { id: 'b', similarity: 0.7 },
      { id: 'c', similarity: 0.7 },
    ]);
    const result = await extractLinks('some decision text', search);
    expect(result.status).toBe('ok');
    expect(result.chosen).toEqual(['a', 'b', 'c']);
    expect(result.candidates.map((x) => x.id)).toEqual(['a', 'b', 'c']);
    expect(result.threshold).toBe(0.6);
  });
});

describe('extractLinks — T-LE-002 mixed candidates above + below threshold', () => {
  it('chooses top-3 above threshold but records all five in candidates', async () => {
    const search = fakeSearch([
      { id: 'a', similarity: 0.9 },
      { id: 'b', similarity: 0.75 },
      { id: 'c', similarity: 0.65 },
      { id: 'd', similarity: 0.55 },
      { id: 'e', similarity: 0.4 },
    ]);
    const result = await extractLinks('text', search);
    expect(result.chosen).toEqual(['a', 'b', 'c']);
    expect(result.candidates).toHaveLength(5);
    expect(result.candidates.map((c) => c.id)).toEqual(['a', 'b', 'c', 'd', 'e']);
  });
});

describe('extractLinks — T-LE-003 all candidates below threshold', () => {
  it('returns empty chosen but records candidates with status ok', async () => {
    const search = fakeSearch([
      { id: 'a', similarity: 0.4 },
      { id: 'b', similarity: 0.3 },
      { id: 'c', similarity: 0.4 },
      { id: 'd', similarity: 0.35 },
    ]);
    const result = await extractLinks('text', search);
    expect(result.status).toBe('ok');
    expect(result.chosen).toEqual([]);
    expect(result.candidates).toHaveLength(4);
  });
});

describe('extractLinks — T-LE-004 search throws', () => {
  it('translates the throw into status:failed with sanitised reason', async () => {
    const search: SearchFn = async () => {
      throw new Error('boom');
    };
    const result = await extractLinks('text', search);
    expect(result.status).toBe('failed');
    expect(result.reason).toBe('boom');
    expect(result.chosen).toEqual([]);
    expect(result.candidates).toEqual([]);
  });

  it('returned promise does NOT reject — the contract is non-throwing', async () => {
    const search: SearchFn = async () => {
      throw new Error('any-error');
    };
    await expect(extractLinks('text', search)).resolves.toBeDefined();
  });
});

describe('extractLinks — T-LE-005 search never resolves (timeout path)', () => {
  it('honours the timeoutMs budget and reports reason: timeout', async () => {
    const search = neverResolves();
    const start = Date.now();
    const result = await extractLinks('text', search, { timeoutMs: 80 });
    const elapsed = Date.now() - start;
    expect(result.status).toBe('failed');
    expect(result.reason).toBe('timeout');
    expect(result.latency_ms).toBeGreaterThanOrEqual(70);
    expect(elapsed).toBeLessThan(500); // generous upper bound; should be ~80
  });
});

describe('extractLinks — T-LE-006 threshold override 0.85', () => {
  it('excludes top hit at 0.7 — chosen is empty but candidate is recorded', async () => {
    const search = fakeSearch([{ id: 'a', similarity: 0.7 }]);
    const result = await extractLinks('text', search, { threshold: 0.85 });
    expect(result.chosen).toEqual([]);
    expect(result.candidates).toEqual([{ id: 'a', confidence: 0.7 }]);
    expect(result.threshold).toBe(0.85);
  });
});

describe('extractLinks — T-LE-007 maxCandidates override 1', () => {
  it('returns at most 1 chosen even when 3 candidates pass threshold', async () => {
    const search = fakeSearch([
      { id: 'a', similarity: 0.9 },
      { id: 'b', similarity: 0.85 },
      { id: 'c', similarity: 0.8 },
    ]);
    const result = await extractLinks('text', search, { maxCandidates: 1 });
    expect(result.chosen).toEqual(['a']);
    expect(result.candidates).toHaveLength(3);
  });
});

describe('extractLinks — T-LE-008 out-of-range threshold clamps to 1.0', () => {
  it('clamps threshold > 1 to 1.0 and emits a stderr warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const search = fakeSearch([
        { id: 'a', similarity: 0.99 },
        { id: 'b', similarity: 0.95 },
      ]);
      const result = await extractLinks('text', search, { threshold: 2.0 });
      expect(result.threshold).toBe(1);
      expect(result.chosen).toEqual([]); // 0.99 < 1.0
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('clamps negative threshold to 0 and keeps everything chosen', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const search = fakeSearch([
        { id: 'a', similarity: 0.4 },
        { id: 'b', similarity: 0.2 },
      ]);
      const result = await extractLinks('text', search, { threshold: -0.5 });
      expect(result.threshold).toBe(0);
      expect(result.chosen).toEqual(['a', 'b']);
    } finally {
      warn.mockRestore();
    }
  });
});

describe('extractLinks — additional invariants', () => {
  it('hard caps candidates at 10 even if search returns more', async () => {
    const rows = Array.from({ length: 15 }, (_, i) => ({
      id: `id-${i}`,
      similarity: 0.7,
    }));
    const result = await extractLinks('text', fakeSearch(rows));
    expect(result.candidates).toHaveLength(10);
    expect(result.chosen).toHaveLength(3); // default maxCandidates
  });

  it('sorts unsorted search input by similarity desc before slicing', async () => {
    const rows = [
      { id: 'low', similarity: 0.5 },
      { id: 'high', similarity: 0.9 },
      { id: 'mid', similarity: 0.7 },
    ];
    const result = await extractLinks('text', fakeSearch(rows));
    expect(result.candidates.map((c) => c.id)).toEqual(['high', 'mid', 'low']);
    expect(result.chosen[0]).toBe('high');
  });

  it('empty text returns failed: empty_text without calling search', async () => {
    const search = vi.fn(async () => []);
    const result = await extractLinks('   ', search);
    expect(result.status).toBe('failed');
    expect(result.reason).toBe('empty_text');
    expect(search).not.toHaveBeenCalled();
  });
});
