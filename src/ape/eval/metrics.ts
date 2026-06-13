/**
 * 285/T012: pure-function APE eval metrics.
 *
 * Contract (plan.md Task 12): all functions take an array of `{ item, mechanical }`
 * rows and return a scalar in [0, 1]. No I/O, no dependencies beyond shared types.
 * Each throws on empty input — failing loud surfaces silent harness bugs (e.g.
 * a corpus that dropped every item), mirroring `benchmarks/metrics.ts`.
 */

import type { ApeCorpusItem, MechanicalLabels } from '../types.js';

export interface MetricRow {
  item: ApeCorpusItem;
  mechanical: MechanicalLabels;
}

type Rows = ReadonlyArray<MetricRow>;

function assertNonEmpty(rows: Rows, fn: string): void {
  if (rows.length === 0) {
    throw new Error(`${fn}: rows must contain at least one result`);
  }
}

/**
 * Precision of the consult signal: TP / (TP + FP) over predicted consults.
 * TP = should_consult && consulted; FP = !should_consult && consulted.
 * No predicted consults → 0 (vacuously imprecise, matches recall-style convention).
 */
export function consultPrecision(rows: Rows): number {
  assertNonEmpty(rows, 'consultPrecision');

  let tp = 0;
  let fp = 0;
  for (const { item, mechanical } of rows) {
    if (!mechanical.consulted) continue;
    if (item.should_consult) tp += 1;
    else fp += 1;
  }
  const predicted = tp + fp;
  return predicted === 0 ? 0 : tp / predicted;
}

/**
 * Recall of the consult signal: TP / (TP + FN) over the positive ground truth.
 * No positive ground truth → 0.
 */
export function consultRecall(rows: Rows): number {
  assertNonEmpty(rows, 'consultRecall');

  let tp = 0;
  let positives = 0;
  for (const { item, mechanical } of rows) {
    if (!item.should_consult) continue;
    positives += 1;
    if (mechanical.consulted) tp += 1;
  }
  return positives === 0 ? 0 : tp / positives;
}

/**
 * Fraction of should_inject items where the agent acted on the injection.
 * No should_inject items → 0.
 */
export function injectActionRate(rows: Rows): number {
  assertNonEmpty(rows, 'injectActionRate');

  let acted = 0;
  let injectTargets = 0;
  for (const { item, mechanical } of rows) {
    if (!item.should_inject) continue;
    injectTargets += 1;
    if (mechanical.acted) acted += 1;
  }
  return injectTargets === 0 ? 0 : acted / injectTargets;
}

/**
 * #290 boundary test: among near_boundary items whose ground truth is negative
 * on BOTH axes (should_consult=false AND should_inject=false), the fraction
 * wrongly consulted OR acted (false positives). No such items → 0.
 */
export function nearBoundaryFpRate(rows: Rows): number {
  assertNonEmpty(rows, 'nearBoundaryFpRate');

  let fp = 0;
  let negatives = 0;
  for (const { item, mechanical } of rows) {
    if (item.stratum !== 'near_boundary') continue;
    if (item.should_consult || item.should_inject) continue;
    negatives += 1;
    if (mechanical.consulted || mechanical.acted) fp += 1;
  }
  return negatives === 0 ? 0 : fp / negatives;
}
