/**
 * 285/T019: optimizer loop + patch emitter.
 *
 * `optimize` runs the full OPRO-style search: it establishes a baseline by
 * evaluating the starting prompt K times on the held-out set (the repeats feed
 * the variance band), then loops — propose candidates, score them on the train
 * set, and promote the best one only if it beats the current baseline on
 * held-out by MORE than the band (variance-band acceptance, Task 18). The loop
 * stops on the first iteration with no accepted improvement, on `maxIters`, or
 * when the spend tracker's `assertWithinCap()` throws (the $40 cap halt,
 * Task 17) — in which case it returns the best variant found so far.
 *
 * The winner is PROPOSED, never applied: on finish the function emits a
 * unified-diff `patch` string anchored on `adapter.deployTarget(surface)`. It
 * NEVER writes to `server.ts` / `inject-block.ts` (const XII — a human applies
 * the patch). Eval is injected (`deps.evalVariant`) so this stays a pure,
 * offline orchestrator with no live model wiring of its own.
 */

import type { AgentAdapter, EvalSummary, Optimizer, PromptVariant } from '../types.js';
import { accepts, measureVarianceBand } from './accept.js';

/** Default K — number of held-out repeats that estimate the variance band. */
const DEFAULT_REPEATS = 5;

/** Minimal spend interface — accumulate cost, fail-loud once over the cap. */
export interface SpendGuard {
  add(usd: number): void;
  total(): number;
  assertWithinCap(): void;
}

export interface OptimizeDeps {
  /** Evaluate a variant on the named corpus split; returns its EvalSummary. */
  evalVariant(variant: PromptVariant, set: 'train' | 'heldOut'): Promise<EvalSummary>;
  /** Adapter providing the real deploy target for the emitted patch. */
  adapter: AgentAdapter;
  /** K held-out repeats used to estimate the variance band. Default 5. */
  repeats?: number;
}

export interface OptimizeOpts {
  start: PromptVariant;
  corpus: unknown; // opaque to the loop — eval is fully delegated to deps.evalVariant
  optimizer: Optimizer;
  deps: OptimizeDeps;
  spend: SpendGuard;
  maxIters: number;
}

export interface OptimizeResult {
  winner: PromptVariant;
  baseline: number;
  accepted: boolean;
  patch: string;
}

/**
 * Collapse an EvalSummary to the single scalar the loop optimises, by surface.
 *
 * Pull (`valis_search` description): the goal is the agent consulting when it
 * should — score = consultRecall (precision is guarded separately by the
 * near-boundary FP rate). Push (injection template): the goal is the agent
 * acting on injected context — score = injectActionRate. Either way, false
 * positives on the near-boundary stratum (#290) subtract directly so a variant
 * cannot win by over-consulting.
 */
export function scoreSummary(summary: EvalSummary, surface: PromptVariant['surface']): number {
  const base =
    surface === 'pull_tool_description' ? summary.consultRecall : summary.injectActionRate;
  return base - summary.nearBoundaryFpRate;
}

/**
 * Render the winning variant as a unified-diff patch against its real deploy
 * target. This is a PROPOSAL — no file is written (const XII). The diff is
 * anchored on the descriptor's `anchor` so a human can locate the edit site;
 * the body documents the surface, file, anchor, and the proposed prompt text.
 */
function emitPatch(adapter: AgentAdapter, winner: PromptVariant): string {
  const target = adapter.deployTarget(winner.surface);
  const lines = [
    `diff --git a/${target.file} b/${target.file}`,
    `--- a/${target.file}`,
    `+++ b/${target.file}`,
    `@@ surface=${target.surface} anchor=${JSON.stringify(target.anchor)} @@`,
    `# APE-proposed prompt variant (${winner.id}) — human applies (const XII)`,
    ...winner.text.split('\n').map((l) => `+${l}`),
  ];
  return lines.join('\n') + '\n';
}

export async function optimize(opts: OptimizeOpts): Promise<OptimizeResult> {
  const { start, optimizer, deps, spend, maxIters } = opts;
  const repeats = deps.repeats ?? DEFAULT_REPEATS;

  // --- Baseline: K held-out repeats of the start variant feed the band. ---
  const baselineScores: number[] = [];
  for (let k = 0; k < repeats; k++) {
    const s = await deps.evalVariant(start, 'heldOut');
    baselineScores.push(scoreSummary(s, start.surface));
  }
  const band = measureVarianceBand(baselineScores);
  let baseline = baselineScores.reduce((a, b) => a + b, 0) / baselineScores.length;

  let current = start;
  let accepted = false;

  // --- Search loop: propose → score on train → promote best if it beats band. ---
  for (let iter = 0; iter < maxIters; iter++) {
    // Halt on budget exceed and return best-so-far (no throw escapes optimize).
    try {
      spend.assertWithinCap();
    } catch {
      break;
    }

    const feedback = await deps.evalVariant(current, 'train');
    const candidates = await optimizer.propose(current, feedback);
    if (candidates.length === 0) break; // optimizer gave up — converged.

    // Rank candidates by their TRAIN score, then validate the best on held-out.
    let bestCandidate: PromptVariant | null = null;
    let bestTrainScore = -Infinity;
    for (const cand of candidates) {
      const trainSummary = await deps.evalVariant(cand, 'train');
      const trainScore = scoreSummary(trainSummary, cand.surface);
      if (trainScore > bestTrainScore) {
        bestTrainScore = trainScore;
        bestCandidate = cand;
      }
    }
    if (!bestCandidate) break;

    const heldOutSummary = await deps.evalVariant(bestCandidate, 'heldOut');
    const heldOutScore = scoreSummary(heldOutSummary, bestCandidate.surface);

    if (accepts(baseline, heldOutScore, band)) {
      current = bestCandidate;
      baseline = heldOutScore;
      accepted = true;
    } else {
      break; // best candidate within the noise band — no improvement, stop.
    }
  }

  return {
    winner: current,
    baseline,
    accepted,
    patch: emitPatch(deps.adapter, current),
  };
}
