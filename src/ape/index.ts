/**
 * 285/T020: `runApe` orchestrator.
 *
 * The single entry point that wires the pinned models (worker = Haiku 4.5,
 * judge / rewriter = Opus 4.8), the spend cap (`opts.budgetUsd ?? 40` — the
 * Cost invariant: $40/run default hard cap, halts on exceed), and
 * `ClaudeCodeAdapter` into one of three offline modes:
 *
 *   - `baseline` — parse off-the-shelf session JSONL (const II) → real-log
 *                  consult/inject rates → report. No gold-set labels needed.
 *   - `eval`     — offline trial eval of the CURRENT prompts over the corpus →
 *                  report. Measures correctness against the gold-set labels.
 *   - `optimize` — full OPRO loop (propose → eval → variance-band accept) →
 *                  report + EMIT a patch file under
 *                  `docs/krukit/285-ape-harness/patches/`. The winner is a
 *                  PROPOSAL: a human applies the patch (const XII). This module
 *                  NEVER edits `server.ts` / `inject-block.ts`.
 *
 * Const III: this is a separate offline process, never in the live hook path.
 *
 * Sub-modules are injected via `ApeRunDeps` (with real-module defaults) so the
 * orchestration is testable without live models or disk reads. The default
 * deps in `defaultDeps()` are the only place that touches the network — every
 * branch below is pure control flow over the injected functions.
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

import type { AgentAdapter, EvalSummary } from './types.js';
import { ClaudeCodeAdapter } from './agents/claude-code.js';
import { evalRealLog } from './eval/real-log.js';
import { writeApeReport, DEFAULT_APE_REPORT_DIR } from './eval/report.js';
import type { ApeRealLogRates, ApeModelAssignments } from './eval/report.js';
import type { OptimizeResult } from './optimizer/loop.js';

/** Cost invariant: $40/run default hard cap (configurable via `--budget-usd`). */
export const DEFAULT_BUDGET_USD = 40;

/** Default patch-emission dir — proposals only; a human applies them (const XII). */
export const DEFAULT_PATCH_DIR = 'docs/krukit/285-ape-harness/patches';

/** Pinned model assignments (plan §Pinned decisions). */
export const APE_MODELS: ApeModelAssignments = {
  worker: 'anthropic/claude-haiku-4.5',
  judge: 'anthropic/claude-opus-4-8',
  rewriter: 'anthropic/claude-opus-4-8',
};

export type ApeMode = 'baseline' | 'eval' | 'optimize';

export interface ApeRunOpts {
  mode: ApeMode;
  /** Real-log baseline source (`baseline` mode). */
  projectsDir?: string;
  /** Gold-set corpus path (`eval` / `optimize` modes). */
  corpus?: string;
  /** Report output dir. Defaults to the 021-sibling ape dir. */
  outDir?: string;
  /** Patch emission dir (`optimize` mode). Defaults to the 285 patches dir. */
  patchDir?: string;
  /** Spend cap override; defaults to $40. */
  budgetUsd?: number;
}

/**
 * Injectable sub-module seam. Defaults wire the real modules; tests pass mocks.
 * `runOptimize` is the loop entry the orchestrator drives in `optimize` mode,
 * already bound to its eval/optimizer/spend deps by the default wiring.
 */
export interface ApeRunDeps {
  evalRealLog: (opts: { projectsDir: string; adapter: AgentAdapter }) => ApeRealLogRates;
  writeApeReport: typeof writeApeReport;
  runOptimize: (opts: { budgetUsd: number; corpus?: string }) => Promise<OptimizeResult>;
  evalCurrent: (opts: { corpus?: string }) => Promise<EvalSummary>;
  gitCommit: () => string;
}

/** Read-only `git rev-parse HEAD`; 'unknown' outside a repo (mirrors benchmarks/index.ts). */
function gitCommit(): string {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf-8' }).trim();
  } catch {
    return 'unknown';
  }
}

/** Empty EvalSummary — the before/after slots when a mode does not measure that side. */
function emptySummary(): EvalSummary {
  return {
    consultPrecision: 0,
    consultRecall: 0,
    injectActionRate: 0,
    nearBoundaryFpRate: 0,
    failingExamples: [],
  };
}

/** Zeroed real-log rates — the slot when a mode does not parse session logs. */
function emptyRealLog(): ApeRealLogRates {
  return { sessions: 0, prompts: 0, consultRate: 0, injectRate: 0 };
}

/**
 * Real-module default deps. This is the ONLY place that touches live models /
 * disk; `runApe` itself is pure control flow over these. The `optimize` and
 * `eval` real wirings are deferred to the autonomous Phase-7 tasks (they need
 * `AI_GATEWAY_API_KEY`); here they fail loud so a misconfigured run never
 * silently produces empty results.
 */
function defaultDeps(): ApeRunDeps {
  return {
    evalRealLog,
    writeApeReport,
    runOptimize: async () => {
      throw new Error(
        'runApe(optimize): live optimizer wiring is gated on AI_GATEWAY_API_KEY ' +
          '(Phase-7, T024). Inject deps.runOptimize for offline runs.',
      );
    },
    evalCurrent: async () => {
      throw new Error(
        'runApe(eval): live offline eval wiring is gated on AI_GATEWAY_API_KEY ' +
          '(Phase-7). Inject deps.evalCurrent for offline runs.',
      );
    },
    gitCommit,
  };
}

export async function runApe(
  opts: ApeRunOpts,
  deps: ApeRunDeps = defaultDeps(),
): Promise<number> {
  const outDir = opts.outDir ?? DEFAULT_APE_REPORT_DIR;
  const budgetUsd = opts.budgetUsd ?? DEFAULT_BUDGET_USD;
  const adapter = new ClaudeCodeAdapter();
  const runId = `ape-${new Date().toISOString().replace(/[:.]/g, '-')}`;

  switch (opts.mode) {
    case 'baseline': {
      const realLog = deps.evalRealLog({
        projectsDir: opts.projectsDir ?? '.',
        adapter,
      });
      await deps.writeApeReport(
        {
          runId,
          gitCommit: deps.gitCommit(),
          models: APE_MODELS,
          before: emptySummary(),
          after: emptySummary(),
          realLog,
          totalSpendUsd: 0,
        },
        outDir,
      );
      return 0;
    }

    case 'eval': {
      const summary = await deps.evalCurrent({ corpus: opts.corpus });
      await deps.writeApeReport(
        {
          runId,
          gitCommit: deps.gitCommit(),
          models: APE_MODELS,
          before: summary,
          after: summary,
          realLog: emptyRealLog(),
          totalSpendUsd: 0,
        },
        outDir,
      );
      return 0;
    }

    case 'optimize': {
      const result = await deps.runOptimize({ budgetUsd, corpus: opts.corpus });

      // Emit the winning variant as a patch FILE — a proposal a human applies
      // (const XII). The orchestrator never edits the deploy target itself.
      const patchDir = opts.patchDir ?? DEFAULT_PATCH_DIR;
      await mkdir(patchDir, { recursive: true });
      const patchPath = join(patchDir, `${runId}.patch`);
      await writeFile(patchPath, result.patch, 'utf-8');

      await deps.writeApeReport(
        {
          runId,
          gitCommit: deps.gitCommit(),
          models: APE_MODELS,
          before: emptySummary(),
          after: emptySummary(),
          realLog: emptyRealLog(),
          totalSpendUsd: 0,
        },
        outDir,
      );
      return 0;
    }

    default: {
      const exhaustive: never = opts.mode;
      throw new Error(`unknown ape mode: ${String(exhaustive)}`);
    }
  }
}
