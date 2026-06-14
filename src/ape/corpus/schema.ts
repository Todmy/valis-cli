/**
 * 285/RT2: ApeScenario corpus schema, loader, and deterministic stratified split.
 *
 * Reshaped from the single-prompt `ApeCorpusItem` to a multi-step `ApeScenario`
 * (design.md §1, amended 2026-06-14). A scenario carries `turns: string[]`; the
 * consult/inject decision is measured at the LAST turn, with turns `[0..n-2]` as
 * real conversational context.
 *
 * Mirrors `benchmarks/corpus-types.ts` (zod line schema + parse/skip) and
 * `benchmarks/corpus.ts` (load + SHA-256 provenance). The corpus is a JSONL
 * file where each non-blank, non-`#`-comment line is one `ApeScenario`.
 *
 * NOTE: `ApeScenario`, `Stratum`, `LabelSource`, and `ScenarioMix` are the
 * canonical types in `ape/types.ts` (promoted by RT9); they are re-exported here
 * so existing `corpus/schema.js` consumers keep one source of truth.
 */

import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { ApeScenario, Stratum, LabelSource, ScenarioMix } from '../types.js';

export type { ApeScenario, Stratum, LabelSource, ScenarioMix } from '../types.js';

/** Default smoke mix: lean multi-step but keep a 1-turn cold-start floor. */
export const DEFAULT_SCENARIO_MIX: ScenarioMix = { 1: 3, 2: 2, 3: 1 };

const StratumSchema = z.enum(['store', 'near_boundary', 'normal']);
const LabelSourceSchema = z.enum(['llm_proposed', 'human_confirmed']);

/** RT17 (F8): a per-scenario relevant injected hit (mirrors SearchResultRow). */
const InjectedHitSchema = z
  .object({
    id: z.string().min(1),
    summary: z.string().min(1),
    type: z.string().min(1),
    status: z.string().min(1).optional(),
    score: z.number(),
    affects: z.array(z.string()).optional(),
  })
  .strict();

/** Zod validator for the `ApeScenario` shape. */
export const ApeScenarioSchema = z
  .object({
    id: z.string().min(1),
    turns: z.array(z.string().min(1)).min(1),
    should_consult: z.boolean(),
    should_inject: z.boolean(),
    stratum: StratumSchema,
    label_source: LabelSourceSchema,
    needs_human_confirm: z.boolean(),
    source_session: z.string().min(1).optional(),
    injected_hits: z.array(InjectedHitSchema).optional(),
  })
  .strict();

/** Thrown on a malformed corpus line; carries the 1-based line number. */
export class ApeCorpusError extends Error {
  constructor(
    message: string,
    public readonly lineNumber?: number,
  ) {
    super(message);
    this.name = 'ApeCorpusError';
  }
}

/**
 * Parse a single JSONL line into an `ApeScenario`.
 *
 * Returns `null` for blank lines and `#`-prefixed comment lines so callers can
 * stream and ignore non-data lines uniformly. Throws `ApeCorpusError` for
 * malformed JSON or a schema violation, attaching the 1-based line number.
 */
export function parseApeScenarioLine(
  line: string,
  lineNumber?: number,
): ApeScenario | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.startsWith('#')) return null;

  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch (err) {
    throw new ApeCorpusError(
      `malformed JSON: ${(err as Error).message}`,
      lineNumber,
    );
  }

  const result = ApeScenarioSchema.safeParse(raw);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new ApeCorpusError(
      `invalid scenario shape: ${issue.path.join('.')} — ${issue.message}`,
      lineNumber,
    );
  }
  return result.data;
}

export interface LoadedApeCorpus {
  scenarios: ApeScenario[];
  /** SHA-256 over the raw file bytes — provenance for reproducible runs. */
  contentHash: string;
}

/**
 * Read a corpus JSONL file into `ApeScenario[]`, skipping blank/comment lines,
 * and attach a SHA-256 provenance hash over the raw bytes. Throws on a missing
 * file or any malformed line (fail-loud, 021 pattern).
 */
export async function loadApeCorpus(path: string): Promise<LoadedApeCorpus> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch (err) {
    throw new ApeCorpusError(
      `corpus not found at ${path}: ${(err as Error).message}`,
    );
  }

  const scenarios: ApeScenario[] = [];
  const lines = raw.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const parsed = parseApeScenarioLine(lines[i], i + 1);
    if (parsed === null) continue;
    scenarios.push(parsed);
  }

  const contentHash = createHash('sha256').update(raw).digest('hex');
  return { scenarios, contentHash };
}

export interface TrainTestSplit {
  train: ApeScenario[];
  test: ApeScenario[];
}

/**
 * Tiny seeded LCG (Numerical Recipes constants). No `Math.random`, so a fixed
 * seed yields a fully reproducible stream — required for deterministic splits.
 */
function makeLcg(seed: number): () => number {
  let state = (seed >>> 0) || 1;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

/** Fisher–Yates shuffle driven by a seeded PRNG. Returns a new array. */
function seededShuffle<T>(arr: T[], rand: () => number): T[] {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Deterministic doubly-stratified train/test split, ~20% to test.
 *
 * Groups by the composite key `(content stratum × turn-length bucket)`, shuffles
 * each cell with a seeded PRNG, then takes the test share per cell. When a cell
 * has ≥2 scenarios, at least one lands in each split — so every content stratum
 * AND every length bucket is represented on both sides (the #290 boundary
 * stratum and each multi-turn bucket must appear in test). With a fixed `seed`
 * the result is reproducible.
 */
export function splitTrainTest(
  scenarios: ApeScenario[],
  seed: number,
  testFraction = 0.2,
): TrainTestSplit {
  const groups = new Map<string, ApeScenario[]>();
  for (const s of scenarios) {
    const key = `${s.stratum}:${s.turns.length}`;
    const bucket = groups.get(key) ?? [];
    bucket.push(s);
    groups.set(key, bucket);
  }

  const train: ApeScenario[] = [];
  const test: ApeScenario[] = [];

  // Iterate cells in a stable order so the seeded stream is reproducible
  // regardless of input ordering.
  const keys = [...groups.keys()].sort();
  for (const key of keys) {
    const group = groups.get(key)!;
    const rand = makeLcg(seed + hashKey(key));
    const shuffled = seededShuffle(group, rand);

    let testCount = Math.round(shuffled.length * testFraction);
    if (shuffled.length >= 2) {
      // Guarantee both splits get at least one from this cell.
      testCount = Math.min(Math.max(testCount, 1), shuffled.length - 1);
    }

    test.push(...shuffled.slice(0, testCount));
    train.push(...shuffled.slice(testCount));
  }

  return { train, test };
}

/** Deterministic small offset so each cell draws a distinct PRNG stream. */
function hashKey(key: string): number {
  let h = 0;
  for (let i = 0; i < key.length; i++) {
    h = (Math.imul(h, 31) + key.charCodeAt(i)) >>> 0;
  }
  return h;
}
