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
import { mkdirSync, writeFileSync } from 'node:fs';
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
  const [schema, pull, push, metrics, report, spend, accept, opro, loop, agent] =
    await Promise.all([
      imp('corpus/schema.js'),
      imp('trial/pull.js'),
      imp('trial/push.js'),
      imp('eval/metrics.js'),
      imp('eval/report.js'),
      imp('optimizer/spend.js'),
      imp('optimizer/accept.js'),
      imp('optimizer/opro.js'),
      imp('optimizer/loop.js'),
      imp('agents/claude-code.js'),
    ]);

  _lib = { schema, pull, push, metrics, report, spend, accept, opro, loop, agent };
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
    entry.acted = lib.push.scorePushAnswer(rawWorkerReply).acted;
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

// ─── RT11: optimize orchestration (rewriter subagent + accept + patch emit) ────
//
// The optimize loop is session-driven exactly like eval: TS owns the control
// flow + pure halves (brief building, decision/candidate parsing, scoring,
// acceptance, patch emission); the session spawns the real-model subagents.
// There are TWO subagent roles here:
//   • WORKER  (session model) — scores a variant over a scenario set (the same
//             pull/push dispatch shape as eval, just for an arbitrary variant).
//   • REWRITER (Opus subagent) — proposes candidate variants from feedback.
//
// Const XII: the winner is PROPOSED. The loop emits a unified-diff PATCH under
// `docs/krukit/285-ape-harness/patches/` and NEVER writes server.ts /
// inject-block.ts. The session applies the patch by hand after the multi-day
// real-session test.
//
// Drive sketch (session side):
//   const opt = await wf.startOptimizeRun({ corpusPath, seed, budget,
//                                           start: { pull, push }, repeats: 5 });
//   // Phase A — baseline: K held-out repeats of `start` per axis.
//   for (const batch of wf.baselineDispatches(opt)) {
//     for (const d of batch) wf.recordVariantResult(opt, d, await spawn(d.brief));
//   }
//   wf.closeBaseline(opt);                       // → variance band + baseline score
//   // Phase B — iterate (bounded by maxIters + budget):
//   while (wf.shouldIterate(opt)) {
//     const brief = wf.rewriterBrief(opt);       // one per surface
//     const raw   = await spawnOpus(brief);      // REWRITER subagent
//     wf.recordCandidates(opt, surface, raw);    // parseCandidates
//     for (const d of wf.candidateDispatches(opt))   // WORKER, train set
//       wf.recordVariantResult(opt, d, await spawn(d.brief));
//     wf.scoreCandidatesOnTrain(opt);
//     for (const d of wf.heldOutDispatches(opt))      // WORKER, held-out
//       wf.recordVariantResult(opt, d, await spawn(d.brief));
//     wf.acceptOrStop(opt);                      // accepts(baseline, score, band)
//   }
//   const { patchPath, report } = await wf.finishOptimizeRun(opt, { outDir });
//
// For MVP we optimise BOTH surfaces in lockstep against the same scenario set;
// each surface gets its own band/baseline/winner and its own emitted patch.

const SURFACES = ['pull_tool_description', 'push_injection_template'];
const DEFAULT_REPEATS = 5;
const PATCH_DIR_REL = ['docs', 'krukit', '285-ape-harness', 'patches'];

/** Map a surface to the corresponding eval axis + brief builder. */
function axisFor(surface) {
  return surface === 'pull_tool_description' ? 'consult' : 'inject';
}

/**
 * Build the dispatches that score ONE variant over a scenario list, on its own
 * axis. Each dispatch carries a `key` so results land in the right per-variant
 * mechanical bucket (variant id + scenario id), letting one worker batch span
 * multiple variants without collision.
 */
function variantDispatches(lib, variant, scenarios, tag) {
  const axis = axisFor(variant.surface);
  const build =
    variant.surface === 'pull_tool_description'
      ? (s) => lib.pull.buildPullBrief(s, variant)
      : (s) => lib.push.buildPushBrief(s, variant);
  return scenarios.map((s) => ({
    key: `${tag}::${variant.id}::${s.id}`,
    variantId: variant.id,
    surface: variant.surface,
    scenarioId: s.id,
    axis,
    brief: build(s),
  }));
}

/**
 * Phase 0 — load + split the corpus and seed the optimize state. `start` carries
 * the two baseline variants (one per surface). Eval scenarios:
 *   train   = split.train   (candidate ranking)
 *   heldOut = split.test    (band estimation + acceptance — never seen at propose)
 */
export async function startOptimizeRun({
  corpusPath,
  seed = 1,
  start = BASELINE_VARIANTS,
  budget = DEFAULT_EVAL_BUDGET,
  repeats = DEFAULT_REPEATS,
  maxIters = 3,
}) {
  const lib = await loadLibrary();

  const { scenarios, contentHash } = await lib.schema.loadApeCorpus(corpusPath);
  if (scenarios.length === 0) {
    throw new Error(`ape-optimize.workflow: corpus ${corpusPath} has no scenarios`);
  }
  const split = lib.schema.splitTrainTest(scenarios, seed);
  if (split.train.length === 0 || split.test.length === 0) {
    throw new Error(
      'ape-optimize.workflow: corpus too small for a train/held-out split',
    );
  }

  return {
    lib,
    adapter: new lib.agent.ClaudeCodeAdapter(),
    corpusPath,
    contentHash,
    seed,
    repeats,
    maxIters,
    iter: 0,
    train: split.train,
    heldOut: split.test,
    // start[surface] keyed by surface for symmetric per-surface optimisation.
    start: { pull_tool_description: start.pull, push_injection_template: start.push },
    // Per-surface running state — filled as the session steps through phases.
    perSurface: Object.fromEntries(
      SURFACES.map((sf) => [
        sf,
        {
          surface: sf,
          current: sf === 'pull_tool_description' ? start.pull : start.push,
          band: null,
          baseline: null,
          accepted: false,
          baselineRepeats: [], // scalar score per held-out repeat
          candidates: [], // PromptVariant[] from the rewriter this iter
          bestCandidate: null,
          done: false, // converged / no-improvement / budget halt
          // RT16/RT15 (F7/F9): tags under which `current`'s TRAIN and HELD-OUT
          // results are actually recorded, so feedback + report read real data
          // (not un-dispatched tags). Updated when a candidate is promoted.
          currentTrainTag: 'cur-train',
          currentHeldTag: 'base-0',
        },
      ]),
    ),
    // variantId+scenarioId → { consulted?, acted? } (one bucket per dispatch key tag).
    mechanical: new Map(),
    budget: lib.spend.createBudget(budget),
  };
}

/** Record one worker reply for an optimize dispatch (mirrors recordWorkerResult). */
export function recordVariantResult(opt, dispatch, rawWorkerReply) {
  const { lib } = opt;
  opt.budget.addCall(estimateBriefTokens(dispatch.brief));
  opt.budget.assertWithin();

  const entry = opt.mechanical.get(dispatch.key) ?? { consulted: false, acted: false };
  if (dispatch.axis === 'consult') {
    entry.consulted = lib.pull.parsePullDecision(rawWorkerReply).consulted;
  } else {
    entry.acted = lib.push.scorePushAnswer(rawWorkerReply).acted;
  }
  opt.mechanical.set(dispatch.key, entry);
}

/** Fold recorded mechanical labels for (variant tag, scenarios) into a scalar score. */
function scoreVariant(opt, variant, scenarios, tag) {
  const { lib } = opt;
  const rows = scenarios.map((s) => {
    const m = opt.mechanical.get(`${tag}::${variant.id}::${s.id}`) ?? {
      consulted: false,
      acted: false,
    };
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
      mechanical: m,
    };
  });
  const summary = {
    consultPrecision: lib.metrics.consultPrecision(rows),
    consultRecall: lib.metrics.consultRecall(rows),
    injectActionRate: lib.metrics.injectActionRate(rows),
    nearBoundaryFpRate: lib.metrics.nearBoundaryFpRate(rows),
    failingExamples: collectFailing(rows, variant.surface),
  };
  // loop.scoreSummary collapses the EvalSummary to the single scalar the loop
  // optimises (consultRecall/injectActionRate minus near-boundary FP).
  return { score: lib.loop.scoreSummary(summary, variant.surface), summary };
}

/** Concrete failing examples feed the rewriter brief (#290 boundary cases first). */
function collectFailing(rows, surface) {
  const wantConsult = surface === 'pull_tool_description';
  const out = [];
  for (const r of rows) {
    const expected = wantConsult ? r.item.should_consult : r.item.should_inject;
    const got = wantConsult ? r.mechanical.consulted : r.mechanical.acted;
    if (expected !== got) {
      out.push({
        prompt: r.item.prompt,
        expected: String(expected),
        got: String(got),
      });
    }
  }
  return out;
}

/**
 * Phase A — baseline dispatches: K held-out repeats of each surface's `current`.
 * Returns one batch per (surface × repeat); the session spawns a worker per
 * dispatch. Each repeat uses a distinct tag so its score is recorded separately
 * (the K scores feed the variance band).
 */
export function baselineDispatches(opt) {
  const batches = [];
  for (const sf of SURFACES) {
    const st = opt.perSurface[sf];
    for (let k = 0; k < opt.repeats; k++) {
      batches.push(variantDispatches(opt.lib, st.current, opt.heldOut, `base-${k}`));
    }
    // RT16 (F7): also score `current` on the TRAIN set under `cur-train`, so the
    // rewriter feedback (rewriterBriefs) reads REAL failing examples instead of
    // an un-dispatched tag that defaults every metric to zero.
    batches.push(variantDispatches(opt.lib, st.current, opt.train, 'cur-train'));
  }
  return batches;
}

/** Close baseline: compute each surface's variance band + mean baseline score. */
export function closeBaseline(opt) {
  for (const sf of SURFACES) {
    const st = opt.perSurface[sf];
    const scores = [];
    for (let k = 0; k < opt.repeats; k++) {
      scores.push(scoreVariant(opt, st.current, opt.heldOut, `base-${k}`).score);
    }
    st.baselineRepeats = scores;
    st.band = opt.lib.accept.measureVarianceBand(scores);
    st.baseline = scores.reduce((a, b) => a + b, 0) / scores.length;
  }
}

/** True while any surface is still improving AND the iter/budget caps allow. */
export function shouldIterate(opt) {
  if (opt.iter >= opt.maxIters) return false;
  try {
    opt.budget.assertWithin();
  } catch {
    return false; // budget halt — keep best-so-far
  }
  return SURFACES.some((sf) => !opt.perSurface[sf].done);
}

/**
 * Phase B step 1 — rewriter briefs (one per still-active surface). The session
 * spawns an OPUS subagent per brief; feed its raw reply to `recordCandidates`.
 */
export function rewriterBriefs(opt) {
  const briefs = [];
  for (const sf of SURFACES) {
    const st = opt.perSurface[sf];
    if (st.done) continue;
    // Feedback = the current variant's train EvalSummary (failing examples
    // included). RT16 (F7): read the tag where current's train results actually
    // live (`cur-train` at iter0; the accepted candidate's train tag after a
    // promotion) — not an un-dispatched `iter${iter}-cur`.
    const { summary } = scoreVariant(opt, st.current, opt.train, st.currentTrainTag);
    briefs.push({
      surface: sf,
      brief: opt.lib.opro.buildRewriterBrief(st.current, summary),
    });
  }
  return briefs;
}

/** Phase B step 2 — parse a rewriter reply into candidate variants for a surface. */
export function recordCandidates(opt, surface, rawRewriterReply) {
  const st = opt.perSurface[surface];
  st.candidates = opt.lib.opro.parseCandidates(rawRewriterReply, st.current);
}

/** Phase B step 3 — worker dispatches scoring every candidate on the TRAIN set. */
export function candidateDispatches(opt) {
  const out = [];
  for (const sf of SURFACES) {
    const st = opt.perSurface[sf];
    if (st.done) continue;
    for (const cand of st.candidates) {
      out.push(...variantDispatches(opt.lib, cand, opt.train, `iter${opt.iter}-train`));
    }
  }
  return out;
}

/** Phase B step 4 — pick each surface's best candidate by train score. */
export function scoreCandidatesOnTrain(opt) {
  for (const sf of SURFACES) {
    const st = opt.perSurface[sf];
    if (st.done) continue;
    let best = null;
    let bestScore = -Infinity;
    for (const cand of st.candidates) {
      const { score } = scoreVariant(opt, cand, opt.train, `iter${opt.iter}-train`);
      if (score > bestScore) {
        bestScore = score;
        best = cand;
      }
    }
    st.bestCandidate = best; // null if the rewriter returned nothing
  }
}

/** Phase B step 5 — worker dispatches validating each best candidate on HELD-OUT. */
export function heldOutDispatches(opt) {
  const out = [];
  for (const sf of SURFACES) {
    const st = opt.perSurface[sf];
    if (st.done || !st.bestCandidate) continue;
    out.push(...variantDispatches(opt.lib, st.bestCandidate, opt.heldOut, `iter${opt.iter}-held`));
  }
  return out;
}

/**
 * Phase B step 6 — variance-band acceptance on held-out. A surface that accepts
 * promotes its best candidate to `current` and raises its baseline; a surface
 * that fails to beat the band (or whose rewriter gave nothing) is marked done.
 * Advances the iteration counter.
 */
export function acceptOrStop(opt) {
  for (const sf of SURFACES) {
    const st = opt.perSurface[sf];
    if (st.done) continue;
    if (!st.bestCandidate) {
      st.done = true; // rewriter converged — no candidates
      continue;
    }
    const { score } = scoreVariant(opt, st.bestCandidate, opt.heldOut, `iter${opt.iter}-held`);
    if (opt.lib.accept.accepts(st.baseline, score, st.band)) {
      st.current = st.bestCandidate;
      st.baseline = score;
      st.accepted = true;
      // RT16/RT15: the promoted candidate's TRAIN + HELD-OUT results are recorded
      // under this iteration's tags — point feedback + report at them.
      st.currentTrainTag = `iter${opt.iter}-train`;
      st.currentHeldTag = `iter${opt.iter}-held`;
    } else {
      st.done = true; // within the noise band — stop this surface
    }
    st.candidates = [];
    st.bestCandidate = null;
  }
  opt.iter += 1;
}

/**
 * Render a winning variant as a unified-diff PATCH against its real deploy
 * target (adapter.deployTarget). PROPOSAL only — anchored on the descriptor so a
 * human can locate the edit site (const XII; never writes the target file).
 */
function emitPatch(adapter, winner) {
  const target = adapter.deployTarget(winner.surface);
  return (
    [
      `diff --git a/${target.file} b/${target.file}`,
      `--- a/${target.file}`,
      `+++ b/${target.file}`,
      `@@ surface=${target.surface} anchor=${JSON.stringify(target.anchor)} @@`,
      `# APE-proposed prompt variant (${winner.id}) — human applies (const XII)`,
      ...winner.text.split('\n').map((l) => `+${l}`),
    ].join('\n') + '\n'
  );
}

/**
 * Finish — emit one PATCH per surface to docs/krukit/285-ape-harness/patches/ and
 * write the before/after report. Returns the patch paths + report paths + the
 * per-surface before/after scores so the session can report real numbers.
 *
 * NEVER writes server.ts / inject-block.ts (const XII): the only files this
 * touches are the patch files under PATCH_DIR_REL and the report under outDir.
 */
export async function finishOptimizeRun(opt, { outDir, runId } = {}) {
  const { lib, adapter } = opt;
  const repoRoot = resolve(CLI_PKG, '..', '..');
  const patchDir = resolve(repoRoot, ...PATCH_DIR_REL);
  mkdirSync(patchDir, { recursive: true });

  const id = runId ?? `ape-optimize-${new Date().toISOString().replace(/[:.]/g, '-')}`;

  const patches = [];
  const surfaces = {};
  for (const sf of SURFACES) {
    const st = opt.perSurface[sf];
    const winner = st.current; // baseline if nothing accepted
    const patch = emitPatch(adapter, winner);
    const patchPath = resolve(patchDir, `${id}-${shortSurface(sf)}.patch`);
    writeFileSync(patchPath, patch, 'utf-8');
    patches.push(patchPath);
    surfaces[sf] = {
      winnerId: winner.id,
      accepted: st.accepted,
      baselineScore: st.baselineRepeats.length
        ? st.baselineRepeats.reduce((a, b) => a + b, 0) / st.baselineRepeats.length
        : null,
      finalScore: st.baseline,
      band: st.band,
      patchPath,
    };
  }

  // Before/after EvalSummary over held-out, RT15 (F9): read REAL recorded results
  // — before = each surface's START variant under a baseline repeat tag (`base-0`);
  // after = its (possibly promoted) CURRENT under the tag where current's held-out
  // results actually live (`base-0` if nothing was accepted, else the accepted
  // candidate's `iter${n}-held`). No un-dispatched tags, no extra spawns.
  const before = combinedSummary(opt, (sf) => ({ variant: opt.start[sf], tag: 'base-0' }));
  const after = combinedSummary(opt, (sf) => ({
    variant: opt.perSurface[sf].current,
    tag: opt.perSurface[sf].currentHeldTag,
  }));

  const { jsonPath, mdPath } = await lib.report.writeApeReport(
    {
      runId: id,
      gitCommit: gitCommit(),
      models: { worker: 'session-model', judge: 'session-opus', rewriter: 'session-opus' },
      before,
      after,
      realLog: { sessions: 0, prompts: 0, consultRate: 0, injectRate: 0 },
      totalSpendUsd: 0,
    },
    outDir,
  );

  return { patches, surfaces, jsonPath, mdPath, calls: opt.budget.calls() };
}

/** Short surface tag for patch filenames. */
function shortSurface(surface) {
  return surface === 'pull_tool_description' ? 'pull' : 'push';
}

/**
 * Build a combined held-out EvalSummary by scoring each surface's chosen variant.
 *
 * Each metric is taken from the surface that actually populates its signal — the
 * pull surface only records `consulted` (so the consult metrics come from there),
 * the push surface only records `acted` (so injectActionRate comes from there).
 * Averaging a metric across BOTH surfaces would halve it (the other surface's rows
 * default that axis to false), which mis-states the human-facing report even though
 * the relative delta survives (review finding, 2026-06-14). `nearBoundaryFpRate`
 * lives on both axes, so it is averaged. Per-surface detail is in
 * `finishOptimizeRun`'s `surfaces` return.
 */
function summaryForSurface(opt, picker, sf) {
  const { lib } = opt;
  const { variant, tag } = picker(sf);
  const rows = opt.heldOut.map((s) => {
    const m = opt.mechanical.get(`${tag}::${variant.id}::${s.id}`) ?? {
      consulted: false,
      acted: false,
    };
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
      mechanical: m,
    };
  });
  return {
    consultPrecision: lib.metrics.consultPrecision(rows),
    consultRecall: lib.metrics.consultRecall(rows),
    injectActionRate: lib.metrics.injectActionRate(rows),
    nearBoundaryFpRate: lib.metrics.nearBoundaryFpRate(rows),
  };
}

function combinedSummary(opt, picker) {
  const pull = summaryForSurface(opt, picker, 'pull_tool_description');
  const push = summaryForSurface(opt, picker, 'push_injection_template');
  return {
    // consult metrics from the pull surface (the only one that records `consulted`)
    consultPrecision: pull.consultPrecision,
    consultRecall: pull.consultRecall,
    // inject-action from the push surface (the only one that records `acted`)
    injectActionRate: push.injectActionRate,
    // near-boundary FP is defined on both axes → average
    nearBoundaryFpRate: (pull.nearBoundaryFpRate + push.nearBoundaryFpRate) / 2,
    failingExamples: [],
  };
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
    // RT20: push reply is now a JUDGE SCORE (stage 2), not a self-report bool.
    recordWorkerResult(run, { scenarioId: s.id, axis: 'inject', brief: pushBrief },
      String(s.should_inject ? 0.9 : 0.1));
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

/**
 * Optimize dry structural check (RT11 verify) — no models, no network, no disk.
 *
 * Drives the optimize state machine end-to-end against a tiny in-memory corpus
 * with FABRICATED worker + rewriter replies, then asserts: baseline produces a
 * finite band + baseline score per surface; a candidate that beats the band gets
 * promoted; the emitted PATCH is anchored on the real deploy target and contains
 * NO server.ts / inject-block.ts file write (it's a diff string only). Proves the
 * RT11 wiring without spawning a subagent or touching the patches dir. The real
 * run is RT14.
 */
export async function optimizeDryCheck() {
  const lib = await loadLibrary();
  const adapter = new lib.agent.ClaudeCodeAdapter();

  // Build a synthetic corpus large enough to split (≥2 per stratum so both halves
  // are non-empty). 4 scenarios: 2 normal-positive, 2 near-boundary-negative.
  const mk = (id, consult, stratum) => ({
    id,
    turns: [`turn for ${id}`],
    should_consult: consult,
    should_inject: consult,
    stratum,
    label_source: 'llm_proposed',
    needs_human_confirm: true,
  });
  const train = [mk('t-pos', true, 'normal'), mk('t-neg', false, 'near_boundary')];
  const heldOut = [mk('h-pos', true, 'normal'), mk('h-neg', false, 'near_boundary')];

  const opt = {
    lib,
    adapter,
    repeats: 3,
    maxIters: 2,
    iter: 0,
    train,
    heldOut,
    start: {
      pull_tool_description: BASELINE_VARIANTS.pull,
      push_injection_template: BASELINE_VARIANTS.push,
    },
    perSurface: Object.fromEntries(
      SURFACES.map((sf) => [
        sf,
        {
          surface: sf,
          current: sf === 'pull_tool_description' ? BASELINE_VARIANTS.pull : BASELINE_VARIANTS.push,
          band: null,
          baseline: null,
          accepted: false,
          baselineRepeats: [],
          candidates: [],
          bestCandidate: null,
          done: false,
          currentTrainTag: 'cur-train',
          currentHeldTag: 'base-0',
        },
      ]),
    ),
    mechanical: new Map(),
    budget: lib.spend.createBudget({ maxCalls: 1000, maxTokensEst: 10_000_000 }),
  };

  // Fabricate a worker reply per dispatch. The baseline variant is "weak" — it
  // NEVER consults/acts (misses every positive, scores 0 on held-out); the
  // rewriter candidate is "perfect" (all positives consult, no near-boundary FP).
  // Baseline scores are identical across repeats → band 0; the perfect candidate
  // beats 0 by a positive margin → accepted (exercises the accept path).
  const replyFor = (dispatch, perfect) => {
    const isPos = dispatch.scenarioId.endsWith('-pos');
    const yes = perfect ? isPos : false; // weak baseline never fires
    return dispatch.axis === 'consult'
      ? JSON.stringify({ would_consult: yes, tool: yes ? 'mcp__valis__valis_search' : null })
      : String(yes ? 0.9 : 0.1); // RT20: push reply is a judge score (stage 2)
  };
  const runBatch = (dispatches, perfect) => {
    for (const d of dispatches) recordVariantResult(opt, d, replyFor(d, perfect));
  };

  // Phase A — baseline (weak).
  for (const batch of baselineDispatches(opt)) runBatch(batch, false);
  closeBaseline(opt);
  for (const sf of SURFACES) {
    const st = opt.perSurface[sf];
    if (typeof st.band !== 'number' || !Number.isFinite(st.band)) {
      throw new Error(`optimizeDryCheck: ${sf} band not finite`);
    }
    if (typeof st.baseline !== 'number' || !Number.isFinite(st.baseline)) {
      throw new Error(`optimizeDryCheck: ${sf} baseline not finite`);
    }
  }

  // Phase B — one iteration with a fabricated rewriter reply (1 perfect candidate).
  if (shouldIterate(opt)) {
    const briefs = rewriterBriefs(opt);
    // RT16 (F7) assertion — feedback is REAL: the weak baseline missed the train
    // positive (`t-pos`), so each rewriter brief must surface that as a concrete
    // failing example (not the old all-zero, no-signal report).
    for (const { brief } of briefs) {
      if (!brief.includes('FAILING EXAMPLES') || !brief.includes('turn for t-pos')) {
        throw new Error('optimizeDryCheck: RT16 — rewriter feedback missing the real failing example');
      }
    }
    for (const { surface } of briefs) {
      recordCandidates(opt, surface, JSON.stringify([{ text: `improved ${surface}` }]));
    }
    runBatch(candidateDispatches(opt), true); // perfect candidate on train
    scoreCandidatesOnTrain(opt);
    runBatch(heldOutDispatches(opt), true); // perfect candidate on held-out
    acceptOrStop(opt);
  }

  // RT15 (F9) assertion — the report's before/after read REAL recorded tags, not
  // un-dispatched ones. Recompute the same way finishOptimizeRun does: before =
  // start under `base-0` (weak → 0), after = current under its held tag (perfect
  // candidate accepted → non-zero). After must beat before on the consult axis.
  const beforeScore = scoreVariant(opt, opt.start.pull_tool_description, opt.heldOut, 'base-0').score;
  const afterTag = opt.perSurface.pull_tool_description.currentHeldTag;
  const afterScore = scoreVariant(
    opt,
    opt.perSurface.pull_tool_description.current,
    opt.heldOut,
    afterTag,
  ).score;
  if (!(afterScore > beforeScore)) {
    throw new Error(
      `optimizeDryCheck: RT15 — report after (${afterScore}) should beat before (${beforeScore})`,
    );
  }

  // Const XII assertion — the emitted patch is a diff STRING anchored on the real
  // deploy target; it never names a write to the target file body.
  for (const sf of SURFACES) {
    const winner = opt.perSurface[sf].current;
    const patch = emitPatch(adapter, winner);
    const target = adapter.deployTarget(sf);
    if (!patch.includes(target.file) || !patch.includes(target.anchor)) {
      throw new Error(`optimizeDryCheck: patch for ${sf} not anchored on deploy target`);
    }
    if (!patch.startsWith('diff --git')) {
      throw new Error(`optimizeDryCheck: patch for ${sf} is not a unified diff`);
    }
  }

  return {
    surfaces: Object.fromEntries(
      SURFACES.map((sf) => {
        const st = opt.perSurface[sf];
        return [sf, { baseline: st.baseline, band: st.band, accepted: st.accepted }];
      }),
    ),
    calls: opt.budget.calls(),
  };
}

// CLI entry: `--check` runs both dry structural verifies (RT10 + RT11 acceptance).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes('--check')) {
    Promise.all([dryCheck(), optimizeDryCheck()])
      .then(([evalR, optR]) => {
        console.log('ape-eval.workflow dryCheck OK:', JSON.stringify(evalR));
        console.log('ape-eval.workflow optimizeDryCheck OK:', JSON.stringify(optR));
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
