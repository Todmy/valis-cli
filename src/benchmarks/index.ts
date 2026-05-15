/**
 * 021 public benchmarks — module barrel + end-to-end runBenchmark.
 *
 * `runBenchmark` is the single entry the CLI binary (`bin/valis-bench.ts`)
 * wires up. Pipeline per `data-model.md` §"State transitions":
 *
 *   1. load corpus            → CorpusSlice
 *   2. seed ephemeral coll.   → EphemeralCollection
 *   3. for each strategy:
 *        run(corpus, fn)      → SliceResult.metrics[variant]
 *   4. assemble BenchmarkResult
 *   5. writeReport            → JSON + Markdown
 *   6. drop ephemeral coll.   (finally block, even on throw)
 *   7. if any gate failed     → print banner, return exit 2
 *      else                   → return exit 0
 */

import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import {
  getDenseModel,
  getVectorSize,
  BM25_MODEL,
} from '../cloud/embedding.js';
import { loadCorpus, type ProvenanceInput } from './corpus.js';
import { seedEphemeralCollection } from './seed.js';
import {
  hybridSearchFn,
  denseOnlySearchFn,
  bm25OnlySearchFn,
} from './search-fns.js';
import { run, HYBRID_GATE_R5 } from './runner.js';
import {
  writeReport,
  renderStdoutTable,
  renderGateFailureBanner,
} from './report.js';
import type {
  BenchmarkResult,
  CorpusProvenance,
  ProductionStackDescriptor,
  SliceResult,
} from './types.js';

export * from './types.js';
export { parseCorpusLine } from './corpus-types.js';

export interface RunBenchmarkOptions {
  corpusId?: string;
  all: boolean;
  outDir: string;
}

interface KnownCorpus {
  corpusId: string;
  sliceName: string;
  provenance: ProvenanceInput;
}

const KNOWN_CORPORA: KnownCorpus[] = [
  {
    corpusId: 'longmemeval-sample',
    sliceName: 'longmemeval',
    provenance: {
      upstream_url: 'https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned',
      license: 'MIT',
      curation_rule:
        'first 500 questions of types single-session-user | single-session-assistant | multi-session | temporal-reasoning | knowledge-update, sorted by question_id ASC; one document per haystack_session (truncated to 1400 chars, answer-bearing turns prioritized); ground_truth = sessions with has_answer:true',
    },
  },
  {
    corpusId: 'valis-multilingual-en',
    sliceName: 'multilingual-en',
    provenance: {
      upstream_url: 'https://github.com/Todmy/valis',
      license: 'Apache-2.0',
      curation_rule: 'Valis-authored team-decision queries (EN), see LICENSE-CORPUS.md',
    },
  },
  {
    corpusId: 'valis-multilingual-uk',
    sliceName: 'multilingual-uk',
    provenance: {
      upstream_url: 'https://github.com/Todmy/valis',
      license: 'Apache-2.0',
      curation_rule: 'Valis-authored team-decision queries (UK), see LICENSE-CORPUS.md',
    },
  },
  {
    corpusId: 'valis-multilingual-pl',
    sliceName: 'multilingual-pl',
    provenance: {
      upstream_url: 'https://github.com/Todmy/valis',
      license: 'Apache-2.0',
      curation_rule: 'Valis-authored team-decision queries (PL), see LICENSE-CORPUS.md',
    },
  },
];

function gitCommit(): string {
  // Read-only `git rev-parse HEAD` with execFile (no shell expansion) —
  // hardcoded args, no user input. Falls back to 'unknown' if not in a repo.
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf-8' }).trim();
  } catch {
    return 'unknown';
  }
}

async function harnessVersion(): Promise<string> {
  // bin/valis-bench → packages/cli/dist/bin → ../../package.json
  // src tree → packages/cli/src/benchmarks → ../../package.json
  const here = dirname(fileURLToPath(import.meta.url));
  for (const candidate of ['../../package.json', '../../../package.json']) {
    try {
      const path = resolve(here, candidate);
      const raw = await readFile(path, 'utf-8');
      const parsed = JSON.parse(raw) as { version?: string };
      if (parsed.version) return parsed.version;
    } catch {
      // try next
    }
  }
  return '0.0.0';
}

function productionStack(): ProductionStackDescriptor {
  return {
    dense_model: getDenseModel(),
    dense_dim: getVectorSize(),
    sparse_model: BM25_MODEL,
    chunking: { chars: 1500, overlap: 200, strategy: 'paragraph-then-sentence' },
    fusion: 'RRF',
    dedup: 'max-score-per-doc_id, overfetch=4x',
  };
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 8);
}

function newRunId(): string {
  // 2026-05-13T20_30_00Z_abc123 — filesystem-safe ISO + 6-char suffix
  const iso = new Date().toISOString().replace(/[:.]/g, '_').replace(/_\d+_Z$/, 'Z');
  return `${iso}_${randomSuffix()}`;
}

async function runOneCorpus(
  spec: KnownCorpus,
  runId: string,
): Promise<{ slice: SliceResult; provenance: CorpusProvenance }> {
  const corpus = await loadCorpus(spec.corpusId, spec.provenance);
  const ephemeral = await seedEphemeralCollection(corpus, runId);
  try {
    const slice = await run({
      corpus,
      searchFns: {
        hybrid: hybridSearchFn(ephemeral.name),
        dense_only: denseOnlySearchFn(ephemeral.name),
        bm25_only: bm25OnlySearchFn(ephemeral.name),
      },
      metricsK: { recall: [5, 10], ndcg: 10 },
      onProgress: (pct, label) => {
        process.stdout.write(`\r  ${spec.sliceName} / ${label ?? '…'}: ${pct.toFixed(0)}%   `);
      },
    });
    process.stdout.write('\n');
    return { slice, provenance: corpus.provenance };
  } finally {
    await ephemeral.drop();
  }
}

export async function runBenchmark(opts: RunBenchmarkOptions): Promise<number> {
  const runId = newRunId();
  const wallClockStart = Date.now();
  const corporaToRun: KnownCorpus[] = opts.all
    ? KNOWN_CORPORA
    : opts.corpusId
      ? KNOWN_CORPORA.filter((c) => c.corpusId === opts.corpusId)
      : [];

  if (corporaToRun.length === 0) {
    if (opts.corpusId) {
      console.error(
        `valis-bench: unknown corpus "${opts.corpusId}". Known: ${KNOWN_CORPORA.map((c) => c.corpusId).join(', ')}`,
      );
    } else {
      console.error('valis-bench: pass --corpus <id> or --all');
    }
    return 1;
  }

  const slices: Record<string, SliceResult> = {};
  const provenances: CorpusProvenance[] = [];
  const skipped: string[] = [];

  for (const spec of corporaToRun) {
    console.log(`\nrunning corpus: ${spec.corpusId}`);
    try {
      const { slice, provenance } = await runOneCorpus(spec, runId);
      slices[spec.sliceName] = slice;
      provenances.push(provenance);
    } catch (err) {
      // Skip-on-missing-corpus: an incomplete multilingual slice (e.g. UA
      // pending DeepL translation) should not abort --all. Hard infra
      // errors (Qdrant down, embedding API timeout) propagate up.
      const msg = (err as Error).message ?? String(err);
      if (/corpus not found/i.test(msg)) {
        console.warn(`  skipped — corpus file missing for ${spec.corpusId}`);
        skipped.push(spec.corpusId);
        continue;
      }
      throw err;
    }
  }

  if (Object.keys(slices).length === 0) {
    console.error(
      `valis-bench: no corpora produced results. Skipped: ${skipped.join(', ') || 'none'}`,
    );
    return 1;
  }

  const result: BenchmarkResult = {
    run_id: runId,
    published_at: '',
    git_commit: gitCommit(),
    production_stack: productionStack(),
    slices,
    wall_clock_ms: Date.now() - wallClockStart,
    harness_version: await harnessVersion(),
    corpus_provenance: provenances,
  };

  const { jsonPath, markdownPath } = await writeReport(result, opts.outDir);
  console.log(renderStdoutTable(result));

  const failedSlice = Object.values(slices).find((s) => !s.gate_passed);
  if (failedSlice) {
    console.error(renderGateFailureBanner(failedSlice));
    console.log(`Artifact written (do NOT publish): ${jsonPath}`);
    console.log(`Markdown summary:                  ${markdownPath}`);
    return 2;
  }

  console.log(`Artifact written: ${jsonPath}`);
  console.log(`Markdown summary: ${markdownPath}`);
  console.log(
    `\nTo publish:\n  cp ${jsonPath} ${opts.outDir}/latest.json\n  git add ${opts.outDir}/latest.json && git commit -m '021: publish benchmark ${runId}'\n`,
  );
  void HYBRID_GATE_R5; // referenced for callers that want the gate value
  return 0;
}
