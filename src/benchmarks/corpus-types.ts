/**
 * 021 public benchmarks — Zod schemas for the corpus JSONL line variants.
 *
 * Matches `specs/021-public-benchmarks/contracts/corpus.schema.json`. Each
 * non-empty, non-comment line in `packages/cli/corpora/<corpusId>.jsonl`
 * MUST parse to one of the three variants below.
 */

import { z } from 'zod';
import { BenchmarkCorpusError } from './types.js';

const LanguageSchema = z.enum(['en', 'uk', 'pl', 'de', 'ja', 'mixed']);

const DocumentSchema = z
  .object({
    id: z.string().min(1),
    text: z.string().min(1),
    language: LanguageSchema.optional(),
    metadata: z.record(z.unknown()).optional(),
  })
  .strict();

const QuerySchema = z
  .object({
    id: z.string().min(1),
    text: z.string().min(1),
    language: LanguageSchema.optional(),
    metadata: z.record(z.unknown()).optional(),
  })
  .strict();

const GroundTruthSchema = z
  .object({
    query_id: z.string().min(1),
    relevant_doc_ids: z.array(z.string().min(1)).min(1),
  })
  .strict();

const CombinedLineSchema = z
  .object({
    document: DocumentSchema,
    query: QuerySchema,
    ground_truth: GroundTruthSchema,
  })
  .strict();

const DocumentLineSchema = z
  .object({
    document: DocumentSchema,
  })
  .strict();

const QueryLineSchema = z
  .object({
    query: QuerySchema,
    ground_truth: GroundTruthSchema,
  })
  .strict();

const CorpusLineSchema = z.union([
  CombinedLineSchema,
  DocumentLineSchema,
  QueryLineSchema,
]);

export type CombinedLine = z.infer<typeof CombinedLineSchema>;
export type DocumentLine = z.infer<typeof DocumentLineSchema>;
export type QueryLine = z.infer<typeof QueryLineSchema>;
export type ParsedCorpusLine = z.infer<typeof CorpusLineSchema>;

/**
 * Parse a single JSONL line.
 *
 * Returns `null` for blank lines and `#`-prefixed comment lines so callers
 * can stream `for await (const line of readline)` and ignore non-data lines
 * uniformly.
 *
 * Throws `BenchmarkCorpusError` for malformed JSON or a Zod-schema
 * violation, attaching the 1-based line number so the user sees
 * `corpus.jsonl:42 — invalid line shape`.
 */
export function parseCorpusLine(
  line: string,
  lineNumber?: number,
): ParsedCorpusLine | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.startsWith('#')) return null;

  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch (err) {
    throw new BenchmarkCorpusError(
      `malformed JSON: ${(err as Error).message}`,
      lineNumber,
    );
  }

  const result = CorpusLineSchema.safeParse(raw);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new BenchmarkCorpusError(
      `invalid line shape: ${issue.path.join('.')} — ${issue.message}`,
      lineNumber,
    );
  }
  return result.data;
}
