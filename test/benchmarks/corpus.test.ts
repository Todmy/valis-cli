/**
 * 021/T009: corpus loader tests — golden fixtures + error paths.
 *
 * loadCorpus reads JSONL from `packages/cli/corpora/<corpusId>.jsonl` by
 * default. Tests use the in-test fixture directory to keep loader logic
 * decoupled from the production corpora directory.
 */

import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { loadCorpusFromFile } from '../../src/benchmarks/corpus.js';
import { BenchmarkCorpusError } from '../../src/benchmarks/types.js';

const FIXTURES_DIR = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures');

describe('loadCorpusFromFile — combined LongMemEval-style', () => {
  it('parses 3 documents + 3 queries + 3 ground truths from a valid fixture', async () => {
    const slice = await loadCorpusFromFile(
      resolve(FIXTURES_DIR, 'valid-combined.jsonl'),
      'combined-fixture',
      {
        upstream_url: 'fixture://valid-combined',
        license: 'CC0-1.0',
        curation_rule: 'inline test fixture',
      },
    );
    expect(slice.id).toBe('combined-fixture');
    expect(slice.documents).toHaveLength(3);
    expect(slice.queries).toHaveLength(3);
    expect(slice.ground_truth).toHaveLength(3);
  });

  it('attaches a SHA-256 content hash to provenance', async () => {
    const slice = await loadCorpusFromFile(
      resolve(FIXTURES_DIR, 'valid-combined.jsonl'),
      'combined-fixture',
      { upstream_url: 'fixture://valid-combined', license: 'CC0-1.0', curation_rule: 'test' },
    );
    expect(slice.provenance.content_hash).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe('loadCorpusFromFile — separate document/query streams', () => {
  it('parses 2 documents + 2 queries from a streams fixture', async () => {
    const slice = await loadCorpusFromFile(
      resolve(FIXTURES_DIR, 'valid-separate-streams.jsonl'),
      'streams-fixture',
      { upstream_url: 'fixture://streams', license: 'CC0-1.0', curation_rule: 'test' },
    );
    expect(slice.documents).toHaveLength(2);
    expect(slice.queries).toHaveLength(2);
    expect(slice.ground_truth).toHaveLength(2);
  });
});

describe('loadCorpusFromFile — error paths', () => {
  it('throws BenchmarkCorpusError with line number on malformed line', async () => {
    await expect(
      loadCorpusFromFile(
        resolve(FIXTURES_DIR, 'malformed.jsonl'),
        'malformed-fixture',
        { upstream_url: 'fixture://malformed', license: 'CC0-1.0', curation_rule: 'test' },
      ),
    ).rejects.toMatchObject({
      name: 'BenchmarkCorpusError',
      lineNumber: 2,
    });
  });

  it('throws on dangling ground_truth references', async () => {
    await expect(
      loadCorpusFromFile(
        resolve(FIXTURES_DIR, 'dangling-gt.jsonl'),
        'dangling-fixture',
        { upstream_url: 'fixture://dangling', license: 'CC0-1.0', curation_rule: 'test' },
      ),
    ).rejects.toThrow(/nonexistent-doc/);
  });

  it('wraps file-not-found errors as BenchmarkCorpusError', async () => {
    await expect(
      loadCorpusFromFile(
        resolve(FIXTURES_DIR, 'does-not-exist.jsonl'),
        'missing-fixture',
        { upstream_url: 'fixture://missing', license: 'CC0-1.0', curation_rule: 'test' },
      ),
    ).rejects.toBeInstanceOf(BenchmarkCorpusError);
  });
});
