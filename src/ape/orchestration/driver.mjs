/**
 * 285/RT19 (F5) — APE orchestration DRIVER.
 *
 * `ape-eval.workflow.js` is session-driven: it rebuilds run/opt deterministically
 * from (corpus, seed), hands out worker/rewriter BRIEFS, and folds the raw replies
 * back. But nothing drives it directly — the Workflow tool has no filesystem
 * access (it cannot read the corpus or import the compiled library), and a bare
 * node process cannot spawn Claude subagents. This driver bridges that gap.
 *
 * ── The driver ↔ session loop ────────────────────────────────────────────────
 * The driver is an IDEMPOTENT, deterministic-replay CLI. Each subcommand:
 *   1. rebuilds run/opt from (corpus, seed) — pure, reproducible;
 *   2. REPLAYS every reply accumulated so far from a JSON file on disk;
 *   3. emits the NEXT batch of briefs the session must dispatch (or finishes).
 * The Claude Code SESSION (the agent) does the part node cannot: spawn one worker
 * subagent per brief (Task/Agent tool, structured-output schema), collect the raw
 * replies, append them to the replies JSON, and re-invoke the driver. Because the
 * driver is a pure replay, re-invoking after adding replies advances the loop.
 *
 *   # eval (one round of worker dispatches):
 *   node driver.mjs eval-dispatch                 # → { dispatches:[{scenarioId,axis,brief}] }
 *   # …session spawns a worker per brief, writes { "<scenarioId>::<axis>": rawReply } to replies.json…
 *   node driver.mjs eval-finish replies.json      # → { jsonPath, mdPath, summary }
 *
 *   # optimize (multiple rounds — re-invoke until {done:true}):
 *   node driver.mjs opt-step replies.json cands.json
 *     → { need:'baseline'|'rewriter'|'candidates'|'heldout', dispatches?|briefs? }  OR  { done:true, result }
 *   # baseline/candidates/heldout: spawn a worker per dispatch, key by dispatch.key, append to replies.json.
 *   # rewriter: spawn an Opus subagent per brief.surface, write { "<surface>": rawArrayReply } to cands.json.
 *
 * ── Config (env or argv) ─────────────────────────────────────────────────────
 *   APE_CORPUS   / --corpus <path>     default: <cli>/corpora/ape-consult-claude-code.jsonl
 *   APE_OUT      / --out <dir>         default: <repo>/packages/web/public/benchmarks/ape
 *   APE_SEED     / --seed <n>          default: 1
 *   APE_REPEATS  / --repeats <n>       default: 2   (optimize baseline K)
 *   APE_MAXITERS / --max-iters <n>     default: 1
 *   APE_MAXCALLS / --max-calls <n>     default: 500
 *   APE_MAXTOKENS/ --max-tokens <n>    default: 5_000_000
 *
 *   node driver.mjs --check            # structural dry-checks (no models, no disk writes)
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as wf from './ape-eval.workflow.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI_PKG = resolve(HERE, '..', '..', '..'); // packages/cli
const REPO = resolve(CLI_PKG, '..', '..');

function flag(name, envName, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  if (envName && process.env[envName]) return process.env[envName];
  return fallback;
}

const CORPUS = flag('corpus', 'APE_CORPUS', resolve(CLI_PKG, 'corpora', 'ape-consult-claude-code.jsonl'));
const OUTDIR = flag('out', 'APE_OUT', resolve(REPO, 'packages', 'web', 'public', 'benchmarks', 'ape'));
const SEED = Number(flag('seed', 'APE_SEED', '1'));
const REPEATS = Number(flag('repeats', 'APE_REPEATS', '2'));
const MAX_ITERS = Number(flag('max-iters', 'APE_MAXITERS', '1'));
const BUDGET = {
  maxCalls: Number(flag('max-calls', 'APE_MAXCALLS', '500')),
  maxTokensEst: Number(flag('max-tokens', 'APE_MAXTOKENS', '5000000')),
};

const loadJson = (p) => (p ? JSON.parse(readFileSync(p, 'utf8')) : {});
const emit = (obj) => console.log(JSON.stringify(obj, null, 2));

const cmd = process.argv[2];

async function main() {
if (cmd === '--check') {
  try {
    const [e, o] = await Promise.all([wf.dryCheck(), wf.optimizeDryCheck()]);
    emit({ ok: true, dryCheck: e, optimizeDryCheck: o });
    process.exit(0);
  } catch (err) {
    console.error('driver --check FAILED:', err.message);
    process.exit(1);
  }
} else if (cmd === 'eval-dispatch') {
  const run = await wf.startEvalRun({ corpusPath: CORPUS, seed: SEED, budget: BUDGET });
  emit({ dispatches: run.dispatches });
} else if (cmd === 'eval-finish') {
  const replies = loadJson(process.argv[3]); // { "<scenarioId>::<axis>": rawReply }
  const run = await wf.startEvalRun({ corpusPath: CORPUS, seed: SEED, budget: BUDGET });
  for (const d of run.dispatches) {
    const key = `${d.scenarioId}::${d.axis}`;
    if (!(key in replies)) throw new Error(`eval-finish: missing reply for ${key}`);
    wf.recordWorkerResult(run, d, replies[key]);
  }
  emit(await wf.finishEvalRun(run, { outDir: OUTDIR }));
} else if (cmd === 'opt-step') {
  const replies = loadJson(process.argv[3]); // { "<dispatch.key>": rawReply }
  const cands = loadJson(process.argv[4]); // { "<surface>": rawRewriterArrayReply }
  const opt = await wf.startOptimizeRun({
    corpusPath: CORPUS,
    seed: SEED,
    budget: BUDGET,
    repeats: REPEATS,
    maxIters: MAX_ITERS,
  });

  // Phase A — baseline (held-out repeats + the cur-train feedback batch, RT16).
  const baseDispatches = wf.baselineDispatches(opt).flat();
  const missingBase = baseDispatches.filter((d) => !(d.key in replies));
  if (missingBase.length) return emit({ need: 'baseline', dispatches: missingBase });
  for (const d of baseDispatches) wf.recordVariantResult(opt, d, replies[d.key]);
  wf.closeBaseline(opt);

  if (!wf.shouldIterate(opt)) {
    return emit({ done: true, result: await wf.finishOptimizeRun(opt, { outDir: OUTDIR }) });
  }

  // Phase B step 1 — rewriter (Opus subagent per surface).
  const briefs = wf.rewriterBriefs(opt);
  const missingCand = briefs.filter((b) => !(b.surface in cands));
  if (missingCand.length) return emit({ need: 'rewriter', briefs });
  for (const b of briefs) wf.recordCandidates(opt, b.surface, cands[b.surface]);

  // Phase B step 3 — candidates on TRAIN.
  const candDispatches = wf.candidateDispatches(opt);
  const missingCT = candDispatches.filter((d) => !(d.key in replies));
  if (missingCT.length) return emit({ need: 'candidates', dispatches: missingCT });
  for (const d of candDispatches) wf.recordVariantResult(opt, d, replies[d.key]);
  wf.scoreCandidatesOnTrain(opt);

  // Phase B step 5 — best candidate on HELD-OUT.
  const heldDispatches = wf.heldOutDispatches(opt);
  const missingHO = heldDispatches.filter((d) => !(d.key in replies));
  if (missingHO.length) return emit({ need: 'heldout', dispatches: missingHO });
  for (const d of heldDispatches) wf.recordVariantResult(opt, d, replies[d.key]);
  wf.acceptOrStop(opt);

  emit({ done: true, result: await wf.finishOptimizeRun(opt, { outDir: OUTDIR }) });
} else {
  console.error(
    'usage: driver.mjs <eval-dispatch | eval-finish <replies.json> | opt-step <replies.json> <cands.json> | --check>',
  );
  process.exit(1);
}
}

main().catch((err) => {
  console.error('driver error:', err.message);
  process.exit(1);
});
