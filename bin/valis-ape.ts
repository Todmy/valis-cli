#!/usr/bin/env node

/**
 * 285/T021: `valis ape` CLI entry point.
 *
 * Drives the APE harness orchestrator (`runApe`, src/ape/index.ts) in one of
 * three offline modes:
 *
 *   - `baseline` — parse off-the-shelf session JSONL → real-log consult/inject
 *                  rates → report (no gold-set labels).
 *   - `eval`     — offline eval of the CURRENT prompts over the corpus → report.
 *   - `optimize` — full OPRO loop → report + EMIT a patch file (a human applies
 *                  it; const XII — never auto-deploys).
 *
 * Const III: a separate offline process, never in the live hook/session path.
 *
 * The parsing + delegation lives in a pure `runCli(argv, deps)` that returns an
 * exit code, mirroring the injectable-deps seam in `runApe` so it is testable
 * without spawning a process. `process.exit` is called only at module load.
 *
 * Usage:
 *   pnpm ape --mode baseline --projects-dir ~/.claude/projects
 *   pnpm ape --mode eval --corpus packages/cli/corpora/ape-consult-claude-code.jsonl
 *   pnpm ape --mode optimize --budget-usd 40
 *
 * Exit codes: 0 success, 2 budget-halt-with-no-improvement (propagated from
 * `runApe`), 1 bad args.
 */

import { Command } from 'commander';

import { runApe, DEFAULT_BUDGET_USD } from '../src/ape/index.js';
import type { ApeRunOpts, ApeMode } from '../src/ape/index.js';

const APE_MODES: ApeMode[] = ['baseline', 'eval', 'optimize'];

/** Injectable seam so the parser can be tested without a live orchestrator. */
export interface CliDeps {
  runApe: (opts: ApeRunOpts) => Promise<number>;
}

/**
 * Parse `argv` (without the `node script` prefix), validate, and delegate to
 * `runApe`. Returns the process exit code — never calls `process.exit` itself.
 * Bad args → 1; otherwise the orchestrator's own exit code (0 / 2).
 */
export async function runCli(
  argv: string[],
  deps: CliDeps = { runApe },
): Promise<number> {
  const program = new Command();

  program
    .name('valis-ape')
    .description('APE harness — eval + optimize Valis consult/capture prompts (285).')
    .requiredOption('-m, --mode <mode>', `run mode: ${APE_MODES.join(' | ')}`)
    .option('-b, --budget-usd <n>', 'spend cap in USD', String(DEFAULT_BUDGET_USD))
    .option(
      '-o, --out <dir>',
      'output directory for the report artifacts',
    )
    .option('-c, --corpus <path>', 'gold-set corpus path (eval / optimize modes)')
    .option('-p, --projects-dir <dir>', 'session-log root (baseline mode)')
    // Throw instead of calling process.exit on a parse error so runCli can map
    // it to exit 1 (commander's default exitOverride is process.exit).
    .exitOverride()
    .configureOutput({ writeErr: (str) => process.stderr.write(str) });

  let parsed: {
    mode: string;
    budgetUsd: string;
    out?: string;
    corpus?: string;
    projectsDir?: string;
  };
  try {
    program.parse(argv, { from: 'user' });
    parsed = program.opts();
  } catch {
    // Missing required option / unknown flag → bad args.
    return 1;
  }

  if (!APE_MODES.includes(parsed.mode as ApeMode)) {
    process.stderr.write(
      `valis-ape: invalid --mode '${parsed.mode}' (expected ${APE_MODES.join(' | ')})\n`,
    );
    return 1;
  }

  const budgetUsd = Number(parsed.budgetUsd);
  if (!Number.isFinite(budgetUsd) || budgetUsd <= 0) {
    process.stderr.write(`valis-ape: invalid --budget-usd '${parsed.budgetUsd}'\n`);
    return 1;
  }

  return deps.runApe({
    mode: parsed.mode as ApeMode,
    budgetUsd,
    outDir: parsed.out,
    corpus: parsed.corpus,
    projectsDir: parsed.projectsDir,
  });
}

// Module-load guard: run only when invoked as the entry point, not on import
// (so the test can import `runCli` without triggering a real run / exit).
if (import.meta.url === `file://${process.argv[1]}`) {
  runCli(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
      console.error('valis-ape: fatal error', err);
      process.exit(1);
    });
}
