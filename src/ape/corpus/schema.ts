/**
 * 285/T005: gold-set corpus schema, loader, and deterministic stratified split.
 *
 * Mirrors `benchmarks/corpus-types.ts` (zod line schema + parse/skip) and
 * `benchmarks/corpus.ts` (load + SHA-256 provenance). The corpus is a JSONL
 * file where each non-blank, non-`#`-comment line is one `ApeCorpusItem`.
 */

import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { ApeCorpusItem, Stratum } from '../types.js';

const StratumSchema = z.enum(['store', 'near_boundary', 'normal']);
const LabelSourceSchema = z.enum(['llm_proposed', 'human_confirmed']);

/** Zod validator for the `ApeCorpusItem` shape from Task 1 (`types.ts`). */
export const ApeCorpusItemSchema = z
  .object({
    id: z.string().min(1),
    prompt: z.string().min(1),
    should_consult: z.boolean(),
    should_inject: z.boolean(),
    stratum: StratumSchema,
    label_source: LabelSourceSchema,
    needs_human_confirm: z.boolean(),
    source_session: z.string().min(1).optional(),
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
 * Parse a single JSONL line into an `ApeCorpusItem`.
 *
 * Returns `null` for blank lines and `#`-prefixed comment lines so callers can
 * stream and ignore non-data lines uniformly. Throws `ApeCorpusError` for
 * malformed JSON or a schema violation, attaching the 1-based line number.
 */
export function parseApeCorpusLine(
  line: string,
  lineNumber?: number,
): ApeCorpusItem | null {
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

  const result = ApeCorpusItemSchema.safeParse(raw);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new ApeCorpusError(
      `invalid item shape: ${issue.path.join('.')} — ${issue.message}`,
      lineNumber,
    );
  }
  return result.data;
}

export interface LoadedApeCorpus {
  items: ApeCorpusItem[];
  /** SHA-256 over the raw file bytes — provenance for reproducible runs. */
  contentHash: string;
}

/**
 * Read a corpus JSONL file into `ApeCorpusItem[]`, skipping blank/comment
 * lines, and attach a SHA-256 provenance hash over the raw bytes. Throws on a
 * missing file or any malformed line (fail-loud, 021 pattern).
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

  const items: ApeCorpusItem[] = [];
  const lines = raw.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const parsed = parseApeCorpusLine(lines[i], i + 1);
    if (parsed === null) continue;
    items.push(parsed);
  }

  const contentHash = createHash('sha256').update(raw).digest('hex');
  return { items, contentHash };
}

export interface TrainTestSplit {
  train: ApeCorpusItem[];
  test: ApeCorpusItem[];
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
 * Deterministic stratified train/test split, ~20% to test.
 *
 * Groups by `stratum`, shuffles each group with a seeded PRNG, then takes the
 * test share per group. When a stratum has ≥2 items, at least one lands in each
 * split so every stratum is represented on both sides (the #290 boundary
 * stratum must appear in test). With a fixed `seed` the result is reproducible.
 */
export function splitTrainTest(
  items: ApeCorpusItem[],
  seed: number,
  testFraction = 0.2,
): TrainTestSplit {
  const groups = new Map<Stratum, ApeCorpusItem[]>();
  for (const it of items) {
    const bucket = groups.get(it.stratum) ?? [];
    bucket.push(it);
    groups.set(it.stratum, bucket);
  }

  const train: ApeCorpusItem[] = [];
  const test: ApeCorpusItem[] = [];

  // Iterate strata in a stable order so the seeded stream is reproducible
  // regardless of input ordering.
  const strata = [...groups.keys()].sort();
  for (const stratum of strata) {
    const group = groups.get(stratum)!;
    const rand = makeLcg(seed + hashStratum(stratum));
    const shuffled = seededShuffle(group, rand);

    let testCount = Math.round(shuffled.length * testFraction);
    if (shuffled.length >= 2) {
      // Guarantee both splits get at least one from this stratum.
      testCount = Math.min(Math.max(testCount, 1), shuffled.length - 1);
    }

    test.push(...shuffled.slice(0, testCount));
    train.push(...shuffled.slice(testCount));
  }

  return { train, test };
}

/** Deterministic small offset so each stratum draws a distinct PRNG stream. */
function hashStratum(stratum: Stratum): number {
  let h = 0;
  for (let i = 0; i < stratum.length; i++) {
    h = (Math.imul(h, 31) + stratum.charCodeAt(i)) >>> 0;
  }
  return h;
}
