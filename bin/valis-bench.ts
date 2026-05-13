#!/usr/bin/env node

/**
 * Valis benchmark harness entry point.
 *
 * Reads `BENCHMARK_QDRANT_URL` + `BENCHMARK_QDRANT_API_KEY` from env, loads
 * a corpus from `packages/cli/corpora/<corpusId>.jsonl`, seeds an ephemeral
 * Qdrant collection, runs three search strategies (hybrid, dense_only,
 * bm25_only), writes a JSON + Markdown report, drops the collection, and
 * exits 0 (gate passed) or 2 (gate failed).
 *
 * Usage:
 *   pnpm valis-bench --corpus longmemeval-sample
 *   pnpm valis-bench --all
 *   pnpm valis-bench --corpus longmemeval-sample --out /tmp/bench
 */

import { Command } from 'commander';
import { runBenchmark } from '../src/benchmarks/index.js';

const program = new Command();

program
  .name('valis-bench')
  .description('Reproducible retrieval benchmark harness for Valis (021).')
  .option('-c, --corpus <id>', 'corpus id to run (e.g., longmemeval-sample)')
  .option('-a, --all', 'run all committed corpora sequentially')
  .option(
    '-o, --out <dir>',
    'output directory for the report artifacts',
    'packages/web/public/benchmarks',
  )
  .parse(process.argv);

const opts = program.opts<{ corpus?: string; all?: boolean; out: string }>();

if (!opts.corpus && !opts.all) {
  console.error('valis-bench: pass --corpus <id> or --all');
  program.help({ error: true });
}

runBenchmark({
  corpusId: opts.corpus,
  all: Boolean(opts.all),
  outDir: opts.out,
})
  .then((exitCode: number) => {
    process.exit(exitCode);
  })
  .catch((err: unknown) => {
    console.error('valis-bench: fatal error', err);
    process.exit(1);
  });
