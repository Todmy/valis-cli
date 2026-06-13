/**
 * 285/T015: ape report writer — ape/eval/report.ts.
 *
 * `writeApeReport(result, outDir)` writes `<runId>.json` + `<runId>.md` under
 * `outDir` (default `packages/web/public/benchmarks/ape/`); it NEVER touches
 * `latest` — promoting a run is a manual founder step (mirrors
 * `benchmarks/report.ts::writeReport`).
 *
 * The report carries: model assignments, before/after EvalSummary, real-log
 * rates, total spend, git commit.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeApeReport } from '../../../src/ape/eval/report.js';
import type { ApeReport } from '../../../src/ape/eval/report.js';
import type { EvalSummary } from '../../../src/ape/types.js';

const TEMP_DIRS: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ape-report-test-'));
  TEMP_DIRS.push(dir);
  return dir;
}
afterAll(async () => {
  for (const dir of TEMP_DIRS) {
    await rm(dir, { recursive: true, force: true });
  }
});

const summary = (over: Partial<EvalSummary> = {}): EvalSummary => ({
  consultPrecision: 0.5,
  consultRecall: 0.5,
  injectActionRate: 0.5,
  nearBoundaryFpRate: 0.5,
  failingExamples: [],
  ...over,
});

function makeResult(): ApeReport {
  return {
    runId: '2026-06-13T10_00_00Z_abc123',
    gitCommit: 'a'.repeat(40),
    models: {
      worker: 'anthropic/claude-haiku-4.5',
      judge: 'anthropic/claude-opus-4-8',
      rewriter: 'anthropic/claude-opus-4-8',
    },
    before: summary({ consultPrecision: 0.6, consultRecall: 0.55, injectActionRate: 0.4 }),
    after: summary({ consultPrecision: 0.82, consultRecall: 0.78, injectActionRate: 0.71 }),
    realLog: { sessions: 12, prompts: 140, consultRate: 0.21, injectRate: 0.33 },
    totalSpendUsd: 12.5,
  };
}

describe('writeApeReport', () => {
  it('writes both files', async () => {
    const dir = await tempDir();
    const result = makeResult();
    const { jsonPath, mdPath } = await writeApeReport(result, dir);

    expect(jsonPath).toBe(join(dir, `${result.runId}.json`));
    expect(mdPath).toBe(join(dir, `${result.runId}.md`));

    const json = JSON.parse(await readFile(jsonPath, 'utf8'));
    expect(json.runId).toBe(result.runId);
    expect(json.models.worker).toBe('anthropic/claude-haiku-4.5');
    expect(json.totalSpendUsd).toBe(12.5);

    const md = await readFile(mdPath, 'utf8');
    expect(md).toContain(result.runId);
  });

  it('does not write latest', async () => {
    const dir = await tempDir();
    const result = makeResult();
    await writeApeReport(result, dir);

    const entries = await readdir(dir);
    expect(entries).not.toContain('latest.json');
    expect(entries).not.toContain('latest.md');
    expect(entries.sort()).toEqual([`${result.runId}.json`, `${result.runId}.md`].sort());
  });

  it('markdown renders before/after table', async () => {
    const dir = await tempDir();
    const result = makeResult();
    const { mdPath } = await writeApeReport(result, dir);
    const md = await readFile(mdPath, 'utf8');

    // A before/after column table with one row per metric.
    expect(md).toContain('| metric | before | after |');
    expect(md).toContain('consultPrecision');
    expect(md).toContain('0.600');
    expect(md).toContain('0.820');
    // real-log baseline + spend + git surfaced.
    expect(md).toContain('consultRate');
    expect(md).toContain(result.gitCommit);
  });
});
