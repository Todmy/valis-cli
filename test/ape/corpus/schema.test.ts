/**
 * 285/RT2: ApeScenario corpus schema + loader + stratified split.
 *
 * Contract (plan.md RT2):
 * - `ApeScenarioSchema` (zod) = `{ id, turns: string[] (min 1), stratum,
 *   should_consult, should_inject, label_source, needs_human_confirm,
 *   source_session? }`.
 * - `parseApeScenarioLine(line, n?)` → scenario, or `null` for blank/comment
 *   lines, throws on malformed JSON / schema violation.
 * - `loadApeCorpus(path)` reads JSONL → `{ scenarios, contentHash }` with a
 *   SHA-256 provenance hash over the raw file bytes.
 * - `splitTrainTest(scenarios, seed)` is a deterministic stratified split,
 *   stratified by BOTH content stratum AND turn-length bucket (each present in
 *   train and test).
 * - `DEFAULT_SCENARIO_MIX` = `{ 1: 3, 2: 2, 3: 1 }`.
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
  ApeScenarioSchema,
  parseApeScenarioLine,
  loadApeCorpus,
  splitTrainTest,
  DEFAULT_SCENARIO_MIX,
  type ApeScenario,
} from '../../../src/ape/corpus/schema.js';

function scenario(overrides: Partial<ApeScenario> = {}): ApeScenario {
  return {
    id: 's1',
    turns: ['implement the auth flow per our PRD'],
    should_consult: true,
    should_inject: true,
    stratum: 'normal',
    label_source: 'llm_proposed',
    needs_human_confirm: true,
    ...overrides,
  };
}

describe('ape/corpus/schema — ApeScenarioSchema', () => {
  it('multi-turn scenario parses', () => {
    const parsed = ApeScenarioSchema.parse(
      scenario({ turns: ['set up the repo', 'add CI', 'now ship the auth flow'] }),
    );
    expect(parsed.turns).toHaveLength(3);
    expect(parsed.turns[2]).toBe('now ship the auth flow');
    expect(parsed.stratum).toBe('normal');
  });

  it('turns min 1 enforced', () => {
    expect(() => ApeScenarioSchema.parse(scenario({ turns: [] }))).toThrow();
  });

  it('missing axis → throws', () => {
    const { should_consult, ...withoutAxis } = scenario();
    void should_consult;
    expect(() => ApeScenarioSchema.parse(withoutAxis)).toThrow();
  });
});

describe('ape/corpus/schema — parseApeScenarioLine', () => {
  it('valid scenario parses', () => {
    const line = JSON.stringify(scenario());
    const parsed = parseApeScenarioLine(line, 1);
    expect(parsed).not.toBeNull();
    expect(parsed?.id).toBe('s1');
  });

  it('blank line → null', () => {
    expect(parseApeScenarioLine('', 1)).toBeNull();
    expect(parseApeScenarioLine('   ', 2)).toBeNull();
    expect(parseApeScenarioLine('# a comment', 3)).toBeNull();
  });

  it('missing axis → throws', () => {
    const { should_inject, ...withoutAxis } = scenario();
    void should_inject;
    const line = JSON.stringify(withoutAxis);
    expect(() => parseApeScenarioLine(line, 7)).toThrow();
  });

  it('malformed JSON → throws', () => {
    expect(() => parseApeScenarioLine('{ not json', 4)).toThrow();
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
      JSON.stringify(scenario({ id: 'a', stratum: 'normal' })),
      '',
      JSON.stringify(scenario({ id: 'b', stratum: 'store' })),
      JSON.stringify(scenario({ id: 'c', stratum: 'near_boundary' })),
    ].join('\n');
    writeFileSync(path, raw);
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads JSONL into scenarios, skipping blank/comment lines', async () => {
    const { scenarios } = await loadApeCorpus(path);
    expect(scenarios.map((s) => s.id)).toEqual(['a', 'b', 'c']);
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

describe('ape/corpus/schema — DEFAULT_SCENARIO_MIX', () => {
  it('scenarioMix default is 3/2/1', () => {
    expect(DEFAULT_SCENARIO_MIX).toEqual({ 1: 3, 2: 2, 3: 1 });
  });
});

describe('ape/corpus/schema — splitTrainTest', () => {
  function corpus(): ApeScenario[] {
    const out: ApeScenario[] = [];
    // Cross every content stratum with every length bucket, enough per cell so
    // a doubly-stratified split puts at least one in each side.
    for (const stratum of ['normal', 'store', 'near_boundary'] as const) {
      for (const len of [1, 2, 3] as const) {
        for (let i = 0; i < 4; i++) {
          out.push(
            scenario({
              id: `${stratum}-${len}-${i}`,
              stratum,
              turns: Array.from({ length: len }, (_, t) => `turn ${t}`),
            }),
          );
        }
      }
    }
    return out;
  }

  it('split is deterministic for a fixed seed', () => {
    const items = corpus();
    const a = splitTrainTest(items, 42);
    const b = splitTrainTest(items, 42);
    expect(a.train.map((s) => s.id)).toEqual(b.train.map((s) => s.id));
    expect(a.test.map((s) => s.id)).toEqual(b.test.map((s) => s.id));
  });

  it('different seeds can produce different splits', () => {
    const items = corpus();
    const a = splitTrainTest(items, 1);
    const b = splitTrainTest(items, 999);
    expect(a.train.map((s) => s.id)).not.toEqual(b.train.map((s) => s.id));
  });

  it('split keeps near_boundary AND each length bucket in both halves', () => {
    const { train, test } = splitTrainTest(corpus(), 7);
    expect(train.some((s) => s.stratum === 'near_boundary')).toBe(true);
    expect(test.some((s) => s.stratum === 'near_boundary')).toBe(true);
    for (const len of [1, 2, 3]) {
      expect(train.some((s) => s.turns.length === len)).toBe(true);
      expect(test.some((s) => s.turns.length === len)).toBe(true);
    }
  });

  it('every content stratum is represented in both splits', () => {
    const { train, test } = splitTrainTest(corpus(), 13);
    for (const stratum of ['normal', 'store', 'near_boundary'] as const) {
      expect(train.some((s) => s.stratum === stratum)).toBe(true);
      expect(test.some((s) => s.stratum === stratum)).toBe(true);
    }
  });

  it('train + test partition the input (no loss, no dup)', () => {
    const items = corpus();
    const { train, test } = splitTrainTest(items, 5);
    const allIds = [...train, ...test].map((s) => s.id).sort();
    expect(allIds).toEqual(items.map((s) => s.id).sort());
    expect(new Set(allIds).size).toBe(items.length);
  });
});
