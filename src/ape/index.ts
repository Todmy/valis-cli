/**
 * 285/RT12: `runApe` orchestrator (re-plan v2 — in-session subagent architecture).
 *
 * The single LLM-free entry point. After the re-plan v2 pivot the eval/optimize
 * loop no longer runs as a standalone API client — it runs as an in-session
 * Claude Code orchestration (a Workflow that spawns real-model subagents). So
 * `runApe` keeps only the shipped, LLM-free `baseline` mode; `eval`/`optimize`
 * print a pointer to that orchestration.
 *
 *   - `baseline` — parse off-the-shelf session JSONL (const II) → real-log
 *                  consult/inject rates → report. No gold-set labels, no models.
 *   - `eval` / `optimize` — the standalone API path is removed. Print a pointer
 *                  to the in-session orchestration (Workflow) and return 0.
 *
 * Const III: this is a separate offline process, never in the live hook path.
 *
 * Sub-modules are injected via `ApeRunDeps` (with real-module defaults) so the
 * baseline branch is testable without disk reads. The default deps in
 * `defaultDeps()` are the only place that touches disk — every branch below is
 * pure control flow over the injected functions.
 */

import { execFileSync } from 'node:child_process';

import type { AgentAdapter } from './types.js';
import { ClaudeCodeAdapter } from './agents/claude-code.js';
import { evalRealLog } from './eval/real-log.js';
import { writeApeReport, DEFAULT_APE_REPORT_DIR } from './eval/report.js';
import type { ApeRealLogRates, ApeModelAssignments } from './eval/report.js';

/**
 * Legacy default kept so the CLI's `--budget-usd` flag still parses. The
 * call/token budget now lives in the in-session orchestration (RT8 `createBudget`),
 * not here; this value is inert for the surviving LLM-free `baseline` mode.
 */
export const DEFAULT_BUDGET_USD = 40;

/** Pinned model assignments (plan §Pinned decisions) — used by the orchestration. */
export const APE_MODELS: ApeModelAssignments = {
  worker: 'anthropic/claude-haiku-4.5',
  judge: 'anthropic/claude-opus-4-8',
  rewriter: 'anthropic/claude-opus-4-8',
};

/** Where the eval/optimize orchestration Workflow lives (printed by the pointer). */
const ORCHESTRATION_DIR = 'packages/cli/src/ape/orchestration/';

export type ApeMode = 'baseline' | 'eval' | 'optimize';

export interface ApeRunOpts {
  mode: ApeMode;
  /** Real-log baseline source (`baseline` mode). */
  projectsDir?: string;
  /** Gold-set corpus path — accepted for CLI compatibility; orchestration-only now. */
  corpus?: string;
  /** Report output dir. Defaults to the 021-sibling ape dir. */
  outDir?: string;
  /** Patch emission dir — accepted for CLI compatibility; orchestration-only now. */
  patchDir?: string;
  /** Spend cap override — accepted for CLI compatibility; inert for `baseline`. */
  budgetUsd?: number;
}

/**
 * Injectable sub-module seam for the surviving LLM-free `baseline` mode. Defaults
 * wire the real modules; tests pass mocks. The eval/optimize loop deps moved to
 * the in-session orchestration (Workflow), so they are no longer here.
 */
export interface ApeRunDeps {
  evalRealLog: (opts: { projectsDir: string; adapter: AgentAdapter }) => ApeRealLogRates;
  writeApeReport: typeof writeApeReport;
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

/** Empty EvalSummary — the unmeasured before/after slots in a baseline (real-log only) report. */
function emptySummary() {
  return {
    consultPrecision: 0,
    consultRecall: 0,
    injectActionRate: 0,
    nearBoundaryFpRate: 0,
    failingExamples: [],
  };
}

/** Real-module default deps for `baseline` mode. The only place that touches disk. */
function defaultDeps(): ApeRunDeps {
  return { evalRealLog, writeApeReport, gitCommit };
}

export async function runApe(
  opts: ApeRunOpts,
  deps: ApeRunDeps = defaultDeps(),
): Promise<number> {
  const outDir = opts.outDir ?? DEFAULT_APE_REPORT_DIR;
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

    case 'eval':
    case 'optimize': {
      // Re-plan v2: the eval/optimize loop is no longer a standalone API client.
      // It runs as an in-session Claude Code orchestration (a Workflow that spawns
      // real-model worker/judge/rewriter subagents). Point the operator there.
      process.stdout.write(
        `valis-ape: --mode ${opts.mode} now runs as the in-session orchestration ` +
          `(Workflow) — see ${ORCHESTRATION_DIR} (ape-eval.workflow.js).\n`,
      );
      return 0;
    }

    default: {
      const exhaustive: never = opts.mode;
      throw new Error(`unknown ape mode: ${String(exhaustive)}`);
    }
  }
}
