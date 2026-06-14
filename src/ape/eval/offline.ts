/**
 * 285/T013: offline trial eval mode.
 *
 * `evalOffline` runs the appropriate trial (pull or push, routed by
 * `variant.surface`) over every corpus item, aggregates the mechanical labels
 * via the pure functions in `metrics.ts`, and collects the prompts the variant
 * handled wrong (`failingExamples`) for the optimizer's feedback signal. Every
 * trial's `costUsd` is accumulated through the passed spend tracker so the
 * orchestrator can halt on the $40 cap.
 *
 * The trial runners are injected (`deps.runPull` / `deps.runPush`) so this stays
 * a pure, offline orchestration: the live worker/judge wiring lives upstream.
 * Quality-axis judging is optional — when `deps.judge` is supplied, each trial
 * is scored on its axis and the spend includes the judge cost too.
 */

import type {
  ApeCorpusItem,
  EvalSummary,
  PromptVariant,
  TrialResult,
} from '../types.js';
import type { MetricRow } from './metrics.js';
import {
  consultPrecision,
  consultRecall,
  injectActionRate,
  nearBoundaryFpRate,
} from './metrics.js';

/**
 * Legacy USD trial shape. RT9 dropped `costUsd` from the canonical `TrialResult`
 * (re-plan v2 — no Gateway, no external key, no USD); this offline module is the
 * old API-path eval slated for the RT10–RT12 orchestration rewrite, so the USD
 * field is inlined here to keep it tsc-clean until then (mirrors the RT1/RT8
 * "resolve the dangling type minimally, don't defer tsc-clean" precedent).
 */
type LegacyTrialResult = TrialResult & { costUsd: number };

/** Legacy axis-scored judge output (canonical judge now returns a bare number). */
interface LegacyJudgeScore {
  axis: 'consult' | 'inject';
  score: number;
}

/** Minimal spend sink — `add(usd)` accumulates trial + judge cost. */
export interface SpendSink {
  add(usd: number): void;
}

type TrialRunner = (variant: PromptVariant, item: ApeCorpusItem) => Promise<LegacyTrialResult>;

export interface EvalOfflineDeps {
  runPull: TrialRunner;
  runPush: TrialRunner;
  spend: SpendSink;
  /** Optional quality-axis judge; scores each trial when supplied. */
  judge?: (
    item: ApeCorpusItem,
    trial: LegacyTrialResult,
  ) => Promise<LegacyJudgeScore[] & { costUsd?: number }>;
}

/**
 * Whether a variant mishandled an item on its own axis — used to collect
 * `failingExamples`. Pull surface: should_consult mismatch. Push surface:
 * should_inject vs acted mismatch.
 */
function isFailure(variant: PromptVariant, item: ApeCorpusItem, trial: LegacyTrialResult): boolean {
  if (variant.surface === 'pull_tool_description') {
    return item.should_consult !== trial.mechanical.consulted;
  }
  return item.should_inject !== trial.mechanical.acted;
}

export async function evalOffline(
  variant: PromptVariant,
  corpus: ReadonlyArray<ApeCorpusItem>,
  deps: EvalOfflineDeps,
): Promise<EvalSummary> {
  const runner = variant.surface === 'pull_tool_description' ? deps.runPull : deps.runPush;

  const rows: MetricRow[] = [];
  const failingExamples: EvalSummary['failingExamples'] = [];

  for (const item of corpus) {
    const trial = await runner(variant, item);
    deps.spend.add(trial.costUsd);

    if (deps.judge) {
      const scores = await deps.judge(item, trial);
      if (typeof scores.costUsd === 'number') deps.spend.add(scores.costUsd);
    }

    rows.push({ item, mechanical: trial.mechanical });

    if (isFailure(variant, item, trial)) {
      const expected =
        variant.surface === 'pull_tool_description'
          ? `consult=${item.should_consult}`
          : `inject=${item.should_inject}`;
      const got =
        variant.surface === 'pull_tool_description'
          ? `consulted=${trial.mechanical.consulted}`
          : `acted=${trial.mechanical.acted}`;
      failingExamples.push({ prompt: item.prompt, expected, got });
    }
  }

  return {
    consultPrecision: consultPrecision(rows),
    consultRecall: consultRecall(rows),
    injectActionRate: injectActionRate(rows),
    nearBoundaryFpRate: nearBoundaryFpRate(rows),
    failingExamples,
  };
}
