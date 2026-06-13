/**
 * 285/T015: ape report writer.
 *
 * Serializes an APE run to a dated JSON artifact + a Markdown summary, mirroring
 * `benchmarks/report.ts::writeReport`. Like the benchmark writer, it does NOT
 * touch `latest` — promoting a run to published is a manual founder step
 * (`cp <runId>.json latest.json`). This keeps gated/cheap runs out of the
 * public artifact by default.
 *
 * The result is supplied pre-built by the orchestrator (it owns git/run-id),
 * so this module is pure I/O + rendering.
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { EvalSummary } from '../types.js';

/** Default artifact location — sibling to the 021 benchmark reports. */
export const DEFAULT_APE_REPORT_DIR = 'packages/web/public/benchmarks/ape';

export interface ApeModelAssignments {
  worker: string;
  judge: string;
  rewriter: string;
}

export interface ApeRealLogRates {
  sessions: number;
  prompts: number;
  consultRate: number;
  injectRate: number;
}

export interface ApeReport {
  runId: string;
  gitCommit: string;
  models: ApeModelAssignments;
  before: EvalSummary;
  after: EvalSummary;
  realLog: ApeRealLogRates;
  totalSpendUsd: number;
}

export async function writeApeReport(
  result: ApeReport,
  outDir: string = DEFAULT_APE_REPORT_DIR,
): Promise<{ jsonPath: string; mdPath: string }> {
  await mkdir(outDir, { recursive: true });

  const jsonPath = join(outDir, `${result.runId}.json`);
  const mdPath = join(outDir, `${result.runId}.md`);

  await writeFile(jsonPath, JSON.stringify(result, null, 2) + '\n', 'utf-8');
  await writeFile(mdPath, renderMarkdown(result), 'utf-8');

  return { jsonPath, mdPath };
}

function fmt(n: number): string {
  return n.toFixed(3);
}

const METRIC_ROWS: { key: keyof EvalSummary; label: string }[] = [
  { key: 'consultPrecision', label: 'consultPrecision' },
  { key: 'consultRecall', label: 'consultRecall' },
  { key: 'injectActionRate', label: 'injectActionRate' },
  { key: 'nearBoundaryFpRate', label: 'nearBoundaryFpRate' },
];

export function renderMarkdown(result: ApeReport): string {
  const lines: string[] = [];
  lines.push(`# APE harness report — ${result.runId}`);
  lines.push('');
  lines.push(`- git commit: \`${result.gitCommit}\``);
  lines.push(`- total spend: $${result.totalSpendUsd.toFixed(2)}`);
  lines.push('');
  lines.push('## Models');
  lines.push('');
  lines.push(`- worker: \`${result.models.worker}\``);
  lines.push(`- judge: \`${result.models.judge}\``);
  lines.push(`- rewriter: \`${result.models.rewriter}\``);
  lines.push('');
  lines.push('## Eval — before vs after');
  lines.push('');
  lines.push('| metric | before | after |');
  lines.push('|---|---|---|');
  for (const { key, label } of METRIC_ROWS) {
    lines.push(`| ${label} | ${fmt(result.before[key] as number)} | ${fmt(result.after[key] as number)} |`);
  }
  lines.push('');
  lines.push('## Real-log baseline (no labels)');
  lines.push('');
  lines.push(`- sessions: ${result.realLog.sessions} · prompts: ${result.realLog.prompts}`);
  lines.push(`- consultRate: ${fmt(result.realLog.consultRate)}`);
  lines.push(`- injectRate: ${fmt(result.realLog.injectRate)}`);
  lines.push('');
  return lines.join('\n');
}
