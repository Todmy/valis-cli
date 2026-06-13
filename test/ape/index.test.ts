/**
 * 285/T020: `runApe` orchestrator.
 *
 * Contract (plan.md Task 20): `runApe(opts) → exitCode`. Modes:
 *   - `baseline` — real-log eval → report.
 *   - `eval`     — offline eval of the current prompts → report.
 *   - `optimize` — full loop → report + emit patch file under
 *                  `docs/krukit/285-ape-harness/patches/`.
 * Wires the pinned models, the spend cap (`opts.budgetUsd ?? 40`), and
 * adapter = ClaudeCodeAdapter.
 *
 * The orchestrator takes injectable sub-module deps so this test can drive it
 * with mocks (no live models / disk reads beyond the patch file it writes).
 *
 * Named cases: baseline mode calls real-log + report / optimize mode runs loop
 * + writes patch file / budgetUsd overrides default.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { runApe, DEFAULT_BUDGET_USD } from '../../src/ape/index.js';
import type { ApeRunDeps } from '../../src/ape/index.js';
import type { EvalSummary, PromptVariant } from '../../src/ape/types.js';

function summary(): EvalSummary {
  return {
    consultPrecision: 1,
    consultRecall: 0.5,
    injectActionRate: 0.5,
    nearBoundaryFpRate: 0,
    failingExamples: [],
  };
}

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'ape-runape-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function makeDeps(over: Partial<ApeRunDeps> = {}): ApeRunDeps {
  return {
    evalRealLog: vi.fn(() => ({ sessions: 2, prompts: 6, consultRate: 0.5, injectRate: 0.3 })),
    writeApeReport: vi.fn(async () => ({
      jsonPath: join(tmp, 'run.json'),
      mdPath: join(tmp, 'run.md'),
    })),
    runOptimize: vi.fn(async () => ({
      winner: { id: 'v1', surface: 'pull_tool_description', text: 'BETTER' } as PromptVariant,
      baseline: 0.5,
      accepted: true,
      patch: 'diff --git a/x b/x\n+BETTER\n',
    })),
    evalCurrent: vi.fn(async () => summary()),
    gitCommit: () => 'deadbeef',
    ...over,
  };
}

describe('runApe', () => {
  it('baseline mode calls real-log + report', async () => {
    const deps = makeDeps();
    const code = await runApe(
      { mode: 'baseline', projectsDir: tmp, outDir: tmp },
      deps,
    );

    expect(code).toBe(0);
    expect(deps.evalRealLog).toHaveBeenCalledTimes(1);
    expect(deps.writeApeReport).toHaveBeenCalledTimes(1);
    // Optimize loop must NOT run in baseline mode.
    expect(deps.runOptimize).not.toHaveBeenCalled();
  });

  it('eval mode runs offline eval of current prompts + report', async () => {
    const deps = makeDeps();
    const code = await runApe(
      { mode: 'eval', corpus: 'pkg/corpora/c.jsonl', outDir: tmp },
      deps,
    );

    expect(code).toBe(0);
    expect(deps.evalCurrent).toHaveBeenCalled();
    expect(deps.writeApeReport).toHaveBeenCalledTimes(1);
    expect(deps.runOptimize).not.toHaveBeenCalled();
  });

  it('optimize mode runs loop + writes patch file', async () => {
    const deps = makeDeps();
    const code = await runApe(
      { mode: 'optimize', corpus: 'pkg/corpora/c.jsonl', outDir: tmp, patchDir: tmp },
      deps,
    );

    expect(code).toBe(0);
    expect(deps.runOptimize).toHaveBeenCalledTimes(1);
    expect(deps.writeApeReport).toHaveBeenCalledTimes(1);

    // A patch file was written under the patch dir.
    const patches = readdirSync(tmp).filter((f) => f.endsWith('.patch'));
    expect(patches.length).toBe(1);
    expect(readFileSync(join(tmp, patches[0]), 'utf-8')).toContain('BETTER');
  });

  it('budgetUsd overrides default', async () => {
    const seen: number[] = [];
    const deps = makeDeps({
      runOptimize: vi.fn(async (opts: { budgetUsd: number }) => {
        seen.push(opts.budgetUsd);
        return {
          winner: { id: 'v0', surface: 'pull_tool_description', text: 't' } as PromptVariant,
          baseline: 0.5,
          accepted: false,
          patch: 'diff\n',
        };
      }),
    });

    await runApe(
      { mode: 'optimize', corpus: 'c.jsonl', outDir: tmp, patchDir: tmp, budgetUsd: 7 },
      deps,
    );
    expect(seen).toEqual([7]);
  });

  it('default budget is 40 when budgetUsd omitted', async () => {
    let captured = -1;
    const deps = makeDeps({
      runOptimize: vi.fn(async (opts: { budgetUsd: number }) => {
        captured = opts.budgetUsd;
        return {
          winner: { id: 'v0', surface: 'pull_tool_description', text: 't' } as PromptVariant,
          baseline: 0.5,
          accepted: false,
          patch: 'diff\n',
        };
      }),
    });

    await runApe({ mode: 'optimize', corpus: 'c.jsonl', outDir: tmp, patchDir: tmp }, deps);
    expect(captured).toBe(DEFAULT_BUDGET_USD);
    expect(DEFAULT_BUDGET_USD).toBe(40);
  });
});
