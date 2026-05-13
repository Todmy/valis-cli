/**
 * 021/T018: report writer — serializes a `BenchmarkResult` to a dated JSON
 * artifact and a Markdown summary suitable for stdout / README inclusion.
 *
 * Does NOT touch `latest.json` — promoting a run to published is a manual
 * step (`cp <runId>.json latest.json`) the founder takes after eyeballing
 * the headline number. This separation keeps gated runs out of the public
 * artifact by default.
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { BenchmarkResult, MetricSet, SliceResult } from './types.js';

export async function writeReport(
  result: BenchmarkResult,
  outputDir: string,
): Promise<{ jsonPath: string; markdownPath: string }> {
  await mkdir(outputDir, { recursive: true });

  const jsonPath = join(outputDir, `${result.run_id}.json`);
  const markdownPath = join(outputDir, `${result.run_id}.md`);

  await writeFile(jsonPath, JSON.stringify(result, null, 2) + '\n', 'utf-8');
  await writeFile(markdownPath, renderMarkdown(result), 'utf-8');

  return { jsonPath, markdownPath };
}

function fmt(n: number): string {
  return n.toFixed(3);
}

function renderMetricRow(label: string, m: MetricSet): string {
  return `| ${label} | ${fmt(m.recall_at_5)} | ${fmt(m.recall_at_10)} | ${fmt(m.mrr)} | ${fmt(m.ndcg_at_10)} |`;
}

function renderSliceMarkdown(name: string, slice: SliceResult): string {
  const header = `### Slice: ${name} (corpus=${slice.corpus}, language=${slice.language})\n`;
  const meta = `- queries: ${slice.n_queries} · documents: ${slice.n_documents}\n- gate: ${slice.gate_passed ? '**PASSED ✓**' : '**FAILED**'} (hybrid recall_at_5 ≥ 0.80)\n`;
  const table = [
    '',
    '| strategy | recall_at_5 | recall_at_10 | mrr | ndcg_at_10 |',
    '|---|---|---|---|---|',
    renderMetricRow('hybrid', slice.metrics.hybrid),
    renderMetricRow('dense_only', slice.metrics.dense_only),
    renderMetricRow('bm25_only', slice.metrics.bm25_only),
    '',
  ].join('\n');
  return header + meta + table;
}

export function renderMarkdown(result: BenchmarkResult): string {
  const lines: string[] = [];
  lines.push(`# Valis benchmark report — ${result.run_id}`);
  lines.push('');
  lines.push(`- harness: \`valis-cli@${result.harness_version}\``);
  lines.push(`- git commit: \`${result.git_commit}\``);
  lines.push(`- wall clock: ${(result.wall_clock_ms / 1000).toFixed(1)} s`);
  lines.push('');
  lines.push('## Production stack');
  lines.push('');
  const ps = result.production_stack;
  lines.push(`- dense: \`${ps.dense_model}\` (${ps.dense_dim}d)`);
  lines.push(`- sparse: \`${ps.sparse_model}\``);
  lines.push(`- chunking: ${ps.chunking.chars} chars, overlap ${ps.chunking.overlap}, strategy \`${ps.chunking.strategy}\``);
  lines.push(`- fusion: \`${ps.fusion}\``);
  lines.push(`- dedup: \`${ps.dedup}\``);
  lines.push('');
  lines.push('## Slices');
  lines.push('');
  for (const [name, slice] of Object.entries(result.slices)) {
    lines.push(renderSliceMarkdown(name, slice));
  }
  lines.push('## Corpus provenance');
  lines.push('');
  for (const p of result.corpus_provenance) {
    lines.push(`- \`${p.corpus_id}\` — ${p.upstream_url} (license: ${p.license}, fetched: ${p.fetched_at})`);
    lines.push(`  - content sha256: \`${p.content_hash}\``);
    lines.push(`  - curation: ${p.curation_rule}`);
  }
  lines.push('');
  return lines.join('\n');
}

/**
 * stdout summary table (one-screen). Used by the CLI on `valis-bench` exit.
 */
export function renderStdoutTable(result: BenchmarkResult): string {
  const lines: string[] = [];
  lines.push('');
  lines.push(`Valis bench ${result.harness_version} — run ${result.run_id}`);
  lines.push(`stack: ${result.production_stack.dense_model} (${result.production_stack.dense_dim}d) + ${result.production_stack.sparse_model} + ${result.production_stack.fusion}`);
  lines.push('');
  for (const [name, slice] of Object.entries(result.slices)) {
    lines.push(`slice: ${name} (corpus=${slice.corpus}, language=${slice.language})`);
    lines.push(`  queries: ${slice.n_queries} · documents: ${slice.n_documents}`);
    lines.push(`  ┌────────────────┬──────────┬────────────┬──────────────┐`);
    lines.push(`  │ metric         │ hybrid   │ dense_only │ bm25_only    │`);
    lines.push(`  ├────────────────┼──────────┼────────────┼──────────────┤`);
    const m = slice.metrics;
    const row = (label: string, key: keyof MetricSet): string =>
      `  │ ${label.padEnd(14)} │ ${fmt(m.hybrid[key] as number).padEnd(8)} │ ${fmt(m.dense_only[key] as number).padEnd(10)} │ ${fmt(m.bm25_only[key] as number).padEnd(12)} │`;
    lines.push(row('recall_at_5', 'recall_at_5'));
    lines.push(row('recall_at_10', 'recall_at_10'));
    lines.push(row('mrr', 'mrr'));
    lines.push(row('ndcg_at_10', 'ndcg_at_10'));
    lines.push(`  └────────────────┴──────────┴────────────┴──────────────┘`);
    lines.push(`  gate (recall_at_5 ≥ 0.80): ${slice.gate_passed ? 'PASSED ✓' : 'FAILED ✗'}`);
    lines.push('');
  }
  return lines.join('\n');
}

/**
 * The red banner emitted on gate failure (per `research.md` R5).
 */
export function renderGateFailureBanner(slice: SliceResult): string {
  return [
    '',
    `WARNING: R@5 below the 80% publication gate for slice ${slice.corpus}.`,
    'Do NOT publish. Investigate before continuing.',
    `Slice score: ${slice.metrics.hybrid.recall_at_5.toFixed(3)}`,
    `Required gate: 0.800`,
    `See: specs/021-public-benchmarks/spec.md §risk`,
    '',
  ].join('\n');
}
