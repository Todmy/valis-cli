/**
 * 021/T016: report writer tests.
 *
 * Assertions:
 *   - JSON file lands at `<outputDir>/<runId>.json`.
 *   - Markdown summary lands at `<outputDir>/<runId>.md`.
 *   - JSON shape matches the contract (runtime spot-checks; full schema
 *     validation happens in integration smoke).
 *   - `writeReport` does NOT touch `latest.json` — that's the manual
 *     "publish" ritual per spec.md §R5.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeReport } from '../../src/benchmarks/report.js';
import type { BenchmarkResult } from '../../src/benchmarks/types.js';

const TEMP_DIRS: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'valis-bench-test-'));
  TEMP_DIRS.push(dir);
  return dir;
}
afterAll(async () => {
  for (const dir of TEMP_DIRS) {
    await rm(dir, { recursive: true, force: true });
  }
});

function makeResult(): BenchmarkResult {
  return {
    run_id: '2026-05-13T20_30_00Z_abc123',
    published_at: '',
    git_commit: 'a'.repeat(40),
    production_stack: {
      dense_model: 'intfloat/multilingual-e5-small',
      dense_dim: 384,
      sparse_model: 'Qdrant/bm25',
      chunking: { chars: 1500, overlap: 200, strategy: 'paragraph-then-sentence' },
      fusion: 'RRF',
      dedup: 'max-score-per-doc_id, overfetch=4x',
    },
    slices: {
      longmemeval: {
        corpus: 'longmemeval-sample',
        language: 'mixed',
        n_queries: 500,
        n_documents: 500,
        metrics: {
          hybrid: {
            recall_at_5: 0.847,
            recall_at_10: 0.916,
            mrr: 0.712,
            ndcg_at_10: 0.787,
            wall_clock_ms: 293_000,
            n_queries_evaluated: 500,
          },
          dense_only: {
            recall_at_5: 0.802,
            recall_at_10: 0.881,
            mrr: 0.668,
            ndcg_at_10: 0.748,
            wall_clock_ms: 192_000,
            n_queries_evaluated: 500,
          },
          bm25_only: {
            recall_at_5: 0.681,
            recall_at_10: 0.764,
            mrr: 0.521,
            ndcg_at_10: 0.612,
            wall_clock_ms: 68_000,
            n_queries_evaluated: 500,
          },
        },
        gate_passed: true,
      },
    },
    wall_clock_ms: 553_000,
    harness_version: '0.2.0',
    corpus_provenance: [
      {
        corpus_id: 'longmemeval-sample',
        upstream_url: 'https://github.com/xiaowu0162/LongMemEval',
        license: 'MIT',
        fetched_at: '2026-05-12',
        content_hash: 'b'.repeat(64),
        curation_rule: 'first 500 questions sorted by question_id ASC',
      },
    ],
  };
}

describe('writeReport', () => {
  it('writes a JSON and a Markdown file named after run_id', async () => {
    const dir = await tempDir();
    const result = makeResult();
    const { jsonPath, markdownPath } = await writeReport(result, dir);
    expect(jsonPath).toContain(`${result.run_id}.json`);
    expect(markdownPath).toContain(`${result.run_id}.md`);
    const files = await readdir(dir);
    expect(files).toContain(`${result.run_id}.json`);
    expect(files).toContain(`${result.run_id}.md`);
  });

  it('JSON content round-trips to the original shape', async () => {
    const dir = await tempDir();
    const result = makeResult();
    const { jsonPath } = await writeReport(result, dir);
    const raw = await readFile(jsonPath, 'utf-8');
    const parsed = JSON.parse(raw) as BenchmarkResult;
    expect(parsed.run_id).toBe(result.run_id);
    expect(parsed.slices.longmemeval.metrics.hybrid.recall_at_5).toBe(0.847);
    expect(parsed.production_stack.dense_model).toBe('intfloat/multilingual-e5-small');
  });

  it('Markdown summary includes all four metrics in a table', async () => {
    const dir = await tempDir();
    const result = makeResult();
    const { markdownPath } = await writeReport(result, dir);
    const md = await readFile(markdownPath, 'utf-8');
    expect(md).toMatch(/recall_at_5/);
    expect(md).toMatch(/recall_at_10/);
    expect(md).toMatch(/mrr/);
    expect(md).toMatch(/ndcg_at_10/);
    expect(md).toMatch(/0\.847/);
  });

  it('does NOT create or modify latest.json', async () => {
    const dir = await tempDir();
    await writeReport(makeResult(), dir);
    const files = await readdir(dir);
    expect(files).not.toContain('latest.json');
  });
});
