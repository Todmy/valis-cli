/**
 * 285/T005: gold-set corpus schema + loader + stratified split.
 *
 * Contract (plan.md Task 5):
 * - `ApeCorpusItemSchema` (zod) validates the `ApeCorpusItem` shape from Task 1.
 * - `parseApeCorpusLine(line, n?)` → item, or `null` for blank/comment lines,
 *   throws on malformed JSON / schema violation.
 * - `loadApeCorpus(path)` reads JSONL → `{ items, contentHash }` with a SHA-256
 *   provenance hash over the raw file bytes.
 * - `splitTrainTest(items, seed)` is a deterministic stratified split (each
 *   stratum represented in both train and test).
 *
 * Pattern mirrors `benchmarks/corpus-types.ts` (zod line schema + parse/skip)
 * and `benchmarks/corpus.ts` (load + SHA-256 provenance).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  ApeCorpusItemSchema,
  parseApeCorpusLine,
  loadApeCorpus,
  splitTrainTest,
} from '../../../src/ape/corpus/schema.js';
import type { ApeCorpusItem } from '../../../src/ape/types.js';

function item(overrides: Partial<ApeCorpusItem> = {}): ApeCorpusItem {
  return {
    id: 'i1',
    prompt: 'implement the auth flow per our PRD',
    should_consult: true,
    should_inject: true,
    stratum: 'normal',
    label_source: 'llm_proposed',
    needs_human_confirm: true,
    ...overrides,
  };
}

describe('ape/corpus/schema — ApeCorpusItemSchema', () => {
  it('valid item parses', () => {
    const parsed = ApeCorpusItemSchema.parse(item());
    expect(parsed.id).toBe('i1');
    expect(parsed.stratum).toBe('normal');
    expect(parsed.should_consult).toBe(true);
  });

  it('missing axis → throws', () => {
    const { should_consult, ...withoutAxis } = item();
    void should_consult;
    expect(() => ApeCorpusItemSchema.parse(withoutAxis)).toThrow();
  });
});

describe('ape/corpus/schema — parseApeCorpusLine', () => {
  it('valid item parses', () => {
    const line = JSON.stringify(item());
    const parsed = parseApeCorpusLine(line, 1);
    expect(parsed).not.toBeNull();
    expect(parsed?.id).toBe('i1');
  });

  it('blank line → null', () => {
    expect(parseApeCorpusLine('', 1)).toBeNull();
    expect(parseApeCorpusLine('   ', 2)).toBeNull();
    expect(parseApeCorpusLine('# a comment', 3)).toBeNull();
  });

  it('missing axis → throws', () => {
    const { should_inject, ...withoutAxis } = item();
    void should_inject;
    const line = JSON.stringify(withoutAxis);
    expect(() => parseApeCorpusLine(line, 7)).toThrow();
  });

  it('malformed JSON → throws', () => {
    expect(() => parseApeCorpusLine('{ not json', 4)).toThrow();
  });
});

describe('ape/corpus/schema — loadApeCorpus', () => {
  let dir: string;
  let path: string;
  let raw: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'ape-corpus-'));
    path = join(dir, 'corpus.jsonl');
    raw = [
      '# bootstrap corpus',
      JSON.stringify(item({ id: 'a', stratum: 'normal' })),
      '',
      JSON.stringify(item({ id: 'b', stratum: 'store' })),
      JSON.stringify(item({ id: 'c', stratum: 'near_boundary' })),
    ].join('\n');
    writeFileSync(path, raw);
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads JSONL into items, skipping blank/comment lines', async () => {
    const { items } = await loadApeCorpus(path);
    expect(items.map((i) => i.id)).toEqual(['a', 'b', 'c']);
  });

  it('attaches a SHA-256 provenance hash over the raw bytes', async () => {
    const { contentHash } = await loadApeCorpus(path);
    const expected = createHash('sha256').update(raw).digest('hex');
    expect(contentHash).toBe(expected);
  });

  it('throws on a missing file', async () => {
    await expect(loadApeCorpus(join(dir, 'nope.jsonl'))).rejects.toThrow();
  });
});

describe('ape/corpus/schema — splitTrainTest', () => {
  function corpus(): ApeCorpusItem[] {
    const out: ApeCorpusItem[] = [];
    // Enough per stratum so a stratified split puts at least one in each side.
    for (const stratum of ['normal', 'store', 'near_boundary'] as const) {
      for (let i = 0; i < 6; i++) {
        out.push(item({ id: `${stratum}-${i}`, stratum }));
      }
    }
    return out;
  }

  it('split is deterministic for a fixed seed', () => {
    const items = corpus();
    const a = splitTrainTest(items, 42);
    const b = splitTrainTest(items, 42);
    expect(a.train.map((i) => i.id)).toEqual(b.train.map((i) => i.id));
    expect(a.test.map((i) => i.id)).toEqual(b.test.map((i) => i.id));
  });

  it('different seeds can produce different splits', () => {
    const items = corpus();
    const a = splitTrainTest(items, 1);
    const b = splitTrainTest(items, 999);
    // Not a hard guarantee, but with 18 items and distinct PRNGs the train
    // membership should differ for at least one item.
    expect(a.train.map((i) => i.id)).not.toEqual(b.train.map((i) => i.id));
  });

  it('near_boundary present in both train and test', () => {
    const { train, test } = splitTrainTest(corpus(), 7);
    expect(train.some((i) => i.stratum === 'near_boundary')).toBe(true);
    expect(test.some((i) => i.stratum === 'near_boundary')).toBe(true);
  });

  it('every stratum is represented in both splits', () => {
    const { train, test } = splitTrainTest(corpus(), 13);
    for (const stratum of ['normal', 'store', 'near_boundary'] as const) {
      expect(train.some((i) => i.stratum === stratum)).toBe(true);
      expect(test.some((i) => i.stratum === stratum)).toBe(true);
    }
  });

  it('train + test partition the input (no loss, no dup)', () => {
    const items = corpus();
    const { train, test } = splitTrainTest(items, 5);
    const allIds = [...train, ...test].map((i) => i.id).sort();
    expect(allIds).toEqual(items.map((i) => i.id).sort());
    expect(new Set(allIds).size).toBe(items.length);
  });
});
