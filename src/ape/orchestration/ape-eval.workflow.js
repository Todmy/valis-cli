/**
 * 285/RT10 — APE eval orchestration workflow (in-session, real-model subagents).
 *
 * This is NOT a unit-tested module and NOT part of the CLI build graph. It is a
 * Workflow script the Claude Code session runs via the Workflow/Task mechanism.
 * It owns the *control flow* of an eval run; the LLM calls themselves are made by
 * the session spawning **worker subagents** on its own model (real Sonnet/Opus,
 * no AI Gateway, no external key, no USD — re-plan v2, design.md §"Trial
 * execution model").
 *
 * ── Division of labour ──────────────────────────────────────────────────────
 *   TS library (pure, tested):  corpus load/split · brief builders · decision
 *                               parsers · metrics · budget · report writer.
 *   This workflow (control):    sequences the stages, holds the budget, marshals
 *                               briefs out / raw worker outputs back in.
 *   The Claude Code session:    spawns one worker subagent per dispatch payload,
 *                               feeds it the brief, forces the structured schema,
 *                               returns the worker's raw reply. TS cannot spawn
 *                               subagents — the session is the only thing that can.
 *
 * ── How it is invoked (no committed compiled artifact) ───────────────────────
 * `dist/` is gitignored, so this script BUILDS the CLI package on first import
 * (`loadLibrary()` runs `pnpm --filter valis-cli build` once) and then imports
 * the compiled ESM from `packages/cli/dist/src/ape/**`. Run it as:
 *
 *   const wf = await import(
 *     'packages/cli/src/ape/orchestration/ape-eval.workflow.js'
 *   );
 *   const run = await wf.startEvalRun({
 *     corpusPath: 'packages/cli/corpora/ape-consult-claude-code.jsonl',
 *     seed: 1,
 *     budget: { maxCalls: 200, maxTokensEst: 2_000_000 },
 *   });
 *   // run.dispatches: [{ scenarioId, axis, brief }, ...]  ← spawn one subagent each
 *   for (const d of run.dispatches) {
 *     const raw = await spawnWorkerSubagent(d.brief);   // SESSION does this (Task tool)
 *     wf.recordWorkerResult(run, d, raw);               // parses + budgets
 *   }
 *   const { jsonPath, mdPath, summary } = await wf.finishEvalRun(run);
 *
 * `spawnWorkerSubagent(brief)` is the session-side step (Stage 2 below). The
 * brief carries `{ context, decisionTurn, tools, schema }`; the subagent must
 * reply with exactly the JSON the `schema` string describes — nothing else.
 *
 * ── Stages (design.md "full loop" diagram, eval half) ────────────────────────
 *   Stage 0  load corpus (node → TS), deterministic stratified split.
 *   Stage 1  build per-(scenario × axis) worker briefs from the candidate
 *            variants (pull = tool-description axis, push = injection-frame axis).
 *   Stage 2  SESSION dispatches each brief to a worker subagent (real model).
 *   Stage 3  parse each worker reply → mechanical {consulted|acted}; budget it.
 *   Stage 4  aggregate into MetricRow[] → EvalSummary via eval/metrics.ts.
 *   Stage 5  write the dated report via eval/report.ts::writeApeReport.
 *
 * RT11 extends THIS file with the optimize loop (rewriter subagent + accept on
 * held-out + patch emission). RT13/RT14 run the real in-session smoke. RT10's
 * own verify is the dry structural parse check at the bottom (`--check`).
 */

import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
// packages/cli  (this file: packages/cli/src/ape/orchestration/…)
const CLI_PKG = resolve(HERE, '..', '..', '..');
const DIST_APE = resolve(CLI_PKG, 'dist', 'src', 'ape');

/** The two prompt surfaces under test, with their shipped baseline descriptions. */
export const BASELINE_VARIANTS = {
  pull: {
    id: 'pull-baseline',
    surface: 'pull_tool_description',
    text: "Search the team's shared decision history for relevant prior decisions, patterns, constraints, and lessons before answering.",
  },
  push: {
    id: 'push-baseline',
    surface: 'push_injection_template',
    text: 'The block below is team decision context retrieved for this prompt. Treat it as authoritative and act on it before answering.',
  },
};

/** Default eval budget — small (real-model subagents are slow + heavy). */
export const DEFAULT_EVAL_BUDGET = { maxCalls: 200, maxTokensEst: 2_000_000 };

/**
 * Build (once) and import the compiled TS library. `dist/` is gitignored, so the
 * first call compiles it; subsequent calls reuse the cached imports.
 */
let _lib = null;
export async function loadLibrary({ rebuild = false } = {}) {
  if (_lib && !rebuild) return _lib;

  // Compile the package so the dist/ paths exist (gitignored artifact).
  try {
    execFileSync('pnpm', ['--filter', 'valis-cli', 'build'], {
      cwd: resolve(CLI_PKG, '..', '..'),
      stdio: 'inherit',
    });
  } catch (err) {
    throw new Error(
      `ape-eval.workflow: building valis-cli failed — ${err.message}. ` +
        'Run `pnpm --filter valis-cli build` manually and retry.',
    );
  }

  const imp = (rel) => import(pathToFileURL(resolve(DIST_APE, rel)).href);
  const [schema, pull, push, metrics, report, spend] = await Promise.all([
    imp('corpus/schema.js'),
    imp('trial/pull.js'),
    imp('trial/push.js'),
    imp('eval/metrics.js'),
    imp('eval/report.js'),
    imp('optimizer/spend.js'),
  ]);

  _lib = { schema, pull, push, metrics, report, spend };
  return _lib;
}

/**
 * Stage 0 + Stage 1 — load + split the corpus, then build every worker brief.
 *
 * Returns a run object the session drives: `dispatches[]` (one brief per
 * scenario × axis) plus internal state for `recordWorkerResult`/`finishEvalRun`.
 * The split is deterministic for a fixed `seed`; eval scores the TEST half so the
 * numbers are held-out from any later optimize step.
 */
export async function startEvalRun({
  corpusPath,
  seed = 1,
  variants = BASELINE_VARIANTS,
  budget = DEFAULT_EVAL_BUDGET,
  evalSplit = 'test',
}) {
  const lib = await loadLibrary();

  const { scenarios, contentHash } = await lib.schema.loadApeCorpus(corpusPath);
  if (scenarios.length === 0) {
    throw new Error(`ape-eval.workflow: corpus ${corpusPath} has no scenarios`);
  }
  const split = lib.schema.splitTrainTest(scenarios, seed);
  const evalScenarios = split[evalSplit];
  if (evalScenarios.length === 0) {
    throw new Error(
      `ape-eval.workflow: ${evalSplit} split is empty (corpus too small for a held-out split)`,
    );
  }

  // Stage 1: build one brief per scenario, per axis it is labelled for.
  //   pull axis  → scenarios with should_consult labelled (consult decision)
  //   push axis  → scenarios with should_inject labelled (act-on-injection)
  // Every scenario carries both flags, so both axes are always exercised; the
  // metrics functions filter to the relevant ground-truth subset.
  const dispatches = [];
  for (const scenario of evalScenarios) {
    dispatches.push({
      scenarioId: scenario.id,
      axis: 'consult',
      brief: lib.pull.buildPullBrief(scenario, variants.pull),
    });
    dispatches.push({
      scenarioId: scenario.id,
      axis: 'inject',
      brief: lib.push.buildPushBrief(scenario, variants.push),
    });
  }

  return {
    lib,
    corpusPath,
    contentHash,
    seed,
    variants,
    evalSplit,
    scenarios: evalScenarios,
    scenarioById: new Map(evalScenarios.map((s) => [s.id, s])),
    dispatches,
    // Stage-3 accumulators: scenarioId → { consulted?, acted? }
    mechanical: new Map(),
    budget: lib.spend.createBudget(budget),
  };
}

/** Rough token estimate (4 chars/token, mirrors hooks/budget.ts) for a brief. */
function estimateBriefTokens(brief) {
  const text =
    brief.context +
    brief.decisionTurn +
    brief.schema +
    brief.tools.map((t) => t.name + t.description).join('');
  return Math.ceil(text.length / 4);
}

/**
 * Stage 3 — record one worker subagent's raw reply for a dispatch.
 *
 * Parses the reply with the axis-appropriate decision parser (fail-loud on
 * unparseable — a silent default would corrupt the metric signal), charges the
 * budget, and asserts the run is still within caps (throws `BudgetExceededError`
 * past `maxCalls` / `maxTokensEst`).
 */
export function recordWorkerResult(run, dispatch, rawWorkerReply) {
  const { lib } = run;
  run.budget.addCall(estimateBriefTokens(dispatch.brief));
  run.budget.assertWithin();

  const entry = run.mechanical.get(dispatch.scenarioId) ?? {
    consulted: false,
    acted: false,
  };
  if (dispatch.axis === 'consult') {
    entry.consulted = lib.pull.parsePullDecision(rawWorkerReply).consulted;
  } else {
    entry.acted = lib.push.parsePushDecision(rawWorkerReply).acted;
  }
  run.mechanical.set(dispatch.scenarioId, entry);
}

/**
 * Stage 4 — fold the recorded mechanical labels into an EvalSummary.
 *
 * Builds the `MetricRow[]` the pure metric functions expect (each row is a
 * `{ item, mechanical }` over the scenario's ground-truth flags + the worker's
 * mechanical decision), then computes the four headline metrics.
 */
export function aggregateEval(run) {
  const { lib } = run;
  const rows = run.scenarios.map((s) => {
    const m = run.mechanical.get(s.id) ?? { consulted: false, acted: false };
    return {
      item: {
        id: s.id,
        prompt: s.turns[s.turns.length - 1],
        should_consult: s.should_consult,
        should_inject: s.should_inject,
        stratum: s.stratum,
        label_source: s.label_source,
        needs_human_confirm: s.needs_human_confirm,
        source_session: s.source_session,
      },
      mechanical: { consulted: m.consulted, acted: m.acted },
    };
  });

  return {
    consultPrecision: lib.metrics.consultPrecision(rows),
    consultRecall: lib.metrics.consultRecall(rows),
    injectActionRate: lib.metrics.injectActionRate(rows),
    nearBoundaryFpRate: lib.metrics.nearBoundaryFpRate(rows),
    failingExamples: [],
  };
}

/** Read-only `git rev-parse HEAD`; 'unknown' outside a repo (mirrors ape/index.ts). */
function gitCommit() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf-8' }).trim();
  } catch {
    return 'unknown';
  }
}

/**
 * Stage 5 — aggregate + write the dated report.
 *
 * For an eval-only run `before === after` (a single measured prompt set), so both
 * slots carry the same EvalSummary; `realLog` is zeroed (the LLM-free real-log
 * baseline is a separate CLI run); `totalSpendUsd` is 0 (no metered billing —
 * the call/token budget is the governance lever). Returns the artifact paths +
 * the summary so the session can report the real numbers.
 */
export async function finishEvalRun(run, { outDir, runId } = {}) {
  const { lib } = run;
  const summary = aggregateEval(run);
  const id = runId ?? `ape-eval-${new Date().toISOString().replace(/[:.]/g, '-')}`;

  const { jsonPath, mdPath } = await lib.report.writeApeReport(
    {
      runId: id,
      gitCommit: gitCommit(),
      models: { worker: 'session-model', judge: 'session-opus', rewriter: 'session-opus' },
      before: summary,
      after: summary,
      realLog: { sessions: 0, prompts: 0, consultRate: 0, injectRate: 0 },
      totalSpendUsd: 0,
    },
    outDir,
  );

  return { jsonPath, mdPath, summary, calls: run.budget.calls() };
}

/**
 * Dry structural check (RT10 verify) — no models, no network, no disk writes.
 *
 * Imports the library, builds briefs over a tiny synthetic 2-scenario corpus held
 * in memory, runs a fabricated worker reply through the parser + aggregation, and
 * asserts the shapes line up. Proves the workflow's wiring against the real TS
 * library without spawning a subagent. The real 2-scenario smoke is RT13/RT14.
 *
 * Run:  node packages/cli/src/ape/orchestration/ape-eval.workflow.js --check
 */
export async function dryCheck() {
  const lib = await loadLibrary();

  // Two synthetic scenarios (one positive, one near-boundary negative), exercising
  // both axes — mirrors the metrics' ground-truth subsets without touching disk.
  const scenarios = [
    {
      id: 's-pos',
      turns: ['We are executing the PRD.', 'Should I check prior auth decisions?'],
      should_consult: true,
      should_inject: true,
      stratum: 'store',
      label_source: 'llm_proposed',
      needs_human_confirm: true,
    },
    {
      id: 's-neg',
      turns: ['Translate this sentence to French.'],
      should_consult: false,
      should_inject: false,
      stratum: 'near_boundary',
      label_source: 'llm_proposed',
      needs_human_confirm: true,
    },
  ];

  const run = {
    lib,
    scenarios,
    scenarioById: new Map(scenarios.map((s) => [s.id, s])),
    mechanical: new Map(),
    budget: lib.spend.createBudget({ maxCalls: 10, maxTokensEst: 100_000 }),
  };

  for (const s of scenarios) {
    const pullBrief = lib.pull.buildPullBrief(s, BASELINE_VARIANTS.pull);
    const pushBrief = lib.push.buildPushBrief(s, BASELINE_VARIANTS.push);
    if (typeof pullBrief.schema !== 'string' || !Array.isArray(pullBrief.tools)) {
      throw new Error('dryCheck: pull brief shape invalid');
    }
    if (!pushBrief.decisionTurn.includes('<valis_search_results')) {
      throw new Error('dryCheck: push brief did not compose the injection block');
    }
    // Fabricated worker replies (positive scenario consults+acts; negative neither).
    const consult = s.should_consult;
    recordWorkerResult(run, { scenarioId: s.id, axis: 'consult', brief: pullBrief },
      JSON.stringify({ would_consult: consult, tool: consult ? 'mcp__valis__valis_search' : null }));
    recordWorkerResult(run, { scenarioId: s.id, axis: 'inject', brief: pushBrief },
      JSON.stringify({ acts_on_injection: s.should_inject }));
  }

  const summary = aggregateEval(run);
  for (const k of ['consultPrecision', 'consultRecall', 'injectActionRate', 'nearBoundaryFpRate']) {
    const v = summary[k];
    if (typeof v !== 'number' || v < 0 || v > 1) {
      throw new Error(`dryCheck: ${k} out of range: ${v}`);
    }
  }
  return { summary, calls: run.budget.calls() };
}

// CLI entry: `--check` runs the dry structural verify (RT10 acceptance).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes('--check')) {
    dryCheck()
      .then((r) => {
        console.log('ape-eval.workflow dryCheck OK:', JSON.stringify(r));
        process.exit(0);
      })
      .catch((err) => {
        console.error('ape-eval.workflow dryCheck FAILED:', err.message);
        process.exit(1);
      });
  } else {
    console.log(
      'ape-eval.workflow: import this module from an in-session orchestration. ' +
        'Run with --check for the dry structural verify.',
    );
  }
}
