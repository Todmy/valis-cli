/**
 * 021/T010: corpus loader — JSONL file → `CorpusSlice`.
 *
 * Reads `packages/cli/corpora/<corpusId>.jsonl` by default. Validates each
 * line against the Zod schema in `corpus-types.ts`, asserts referential
 * integrity between `GroundTruth.relevant_doc_ids` and `Document.id`s in
 * the same corpus, and attaches a SHA-256 content hash to provenance.
 *
 * `loadCorpus` is the production entry point (resolves the corpora dir
 * automatically). `loadCorpusFromFile` is the test-friendly variant that
 * takes an explicit path — both share the parsing core.
 */

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BenchmarkCorpusError,
  type CorpusProvenance,
  type CorpusSlice,
  type Document,
  type GroundTruth,
  type Language,
  type Query,
} from './types.js';
import { parseCorpusLine } from './corpus-types.js';

/**
 * Resolve `packages/cli/corpora/` from the running module location, then
 * append `<corpusId>.jsonl`. Works in both compiled `dist/` and test runs.
 *
 * From `dist/src/benchmarks/`: walk 3 levels up to reach `packages/cli/`.
 * From `src/benchmarks/`     : walk 2 levels up. Try both and return the
 * first that exists so we don't hard-code knowledge of which tree the
 * caller booted from.
 */
function corporaDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const candidate of ['../../corpora', '../../../corpora']) {
    const dir = resolve(here, candidate);
    if (existsSync(dir)) return dir;
  }
  return resolve(here, '../../corpora');
}

export interface ProvenanceInput {
  upstream_url: string;
  license: string;
  curation_rule: string;
  fetched_at?: string;
}

/**
 * Test-friendly variant of `loadCorpus` — caller passes the JSONL path
 * directly. Used by `corpus.test.ts` for golden fixtures.
 */
export async function loadCorpusFromFile(
  path: string,
  corpusId: string,
  provenanceInput: ProvenanceInput,
): Promise<CorpusSlice> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch (err) {
    throw new BenchmarkCorpusError(
      `corpus not found at ${path}: ${(err as Error).message}`,
      undefined,
      corpusId,
    );
  }

  const documents: Document[] = [];
  const queries: Query[] = [];
  const groundTruth: GroundTruth[] = [];

  const lines = raw.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const parsed = parseCorpusLine(lines[i], i + 1);
    if (parsed === null) continue;

    if ('document' in parsed && parsed.document) documents.push(parsed.document);
    if ('query' in parsed && parsed.query) queries.push(parsed.query);
    if ('ground_truth' in parsed && parsed.ground_truth) {
      groundTruth.push(parsed.ground_truth);
    }
  }

  const docIds = new Set(documents.map((d) => d.id));
  for (const gt of groundTruth) {
    for (const docId of gt.relevant_doc_ids) {
      if (!docIds.has(docId)) {
        throw new BenchmarkCorpusError(
          `referential integrity: ground_truth for query "${gt.query_id}" references doc "${docId}" not present in the corpus`,
          undefined,
          corpusId,
        );
      }
    }
  }

  const contentHash = createHash('sha256').update(raw).digest('hex');
  const provenance: CorpusProvenance = {
    corpus_id: corpusId,
    upstream_url: provenanceInput.upstream_url,
    license: provenanceInput.license,
    fetched_at: provenanceInput.fetched_at ?? new Date().toISOString(),
    content_hash: contentHash,
    curation_rule: provenanceInput.curation_rule,
  };

  return {
    id: corpusId,
    language: inferSliceLanguage(documents, queries),
    documents,
    queries,
    ground_truth: groundTruth,
    provenance,
  };
}

/**
 * Production entry: looks up the JSONL under `packages/cli/corpora/` by
 * `<corpusId>.jsonl` and delegates to `loadCorpusFromFile`.
 */
export async function loadCorpus(
  corpusId: string,
  provenanceInput: ProvenanceInput,
): Promise<CorpusSlice> {
  return loadCorpusFromFile(resolve(corporaDir(), `${corpusId}.jsonl`), corpusId, provenanceInput);
}

function inferSliceLanguage(documents: Document[], queries: Query[]): Language {
  const langs = new Set<Language>();
  for (const d of documents) if (d.language) langs.add(d.language);
  for (const q of queries) if (q.language) langs.add(q.language);
  if (langs.size === 0) return 'mixed';
  if (langs.size === 1) return [...langs][0];
  return 'mixed';
}
