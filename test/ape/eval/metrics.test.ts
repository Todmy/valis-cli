/**
 * 285/T012: tabular tests for the pure APE eval metrics.
 *
 * Contract (plan.md Task 12): inputs are arrays of `{ item, mechanical }`.
 * - consultPrecision / consultRecall over `should_consult` vs `mechanical.consulted`
 * - injectActionRate = fraction of should_inject items where mechanical.acted
 * - nearBoundaryFpRate = among near_boundary items with should_*=false,
 *   fraction wrongly consulted/acted (the #290 boundary test)
 * - all throw on empty input (fail-loud)
 */

import { describe, it, expect } from 'vitest';
import {
  consultPrecision,
  consultRecall,
  injectActionRate,
  nearBoundaryFpRate,
} from '../../../src/ape/eval/metrics.js';
import type { ApeCorpusItem, MechanicalLabels } from '../../../src/ape/types.js';

function item(over: Partial<ApeCorpusItem>): ApeCorpusItem {
  return {
    id: over.id ?? 'i',
    prompt: over.prompt ?? 'p',
    should_consult: over.should_consult ?? false,
    should_inject: over.should_inject ?? false,
    stratum: over.stratum ?? 'normal',
    label_source: over.label_source ?? 'llm_proposed',
    needs_human_confirm: over.needs_human_confirm ?? true,
    source_session: over.source_session,
  };
}

function mech(consulted: boolean, acted = false): MechanicalLabels {
  return { consulted, acted };
}

type Row = { item: ApeCorpusItem; mechanical: MechanicalLabels };

describe('consultPrecision', () => {
  it('computes TP / (TP + FP)', () => {
    // 2 predicted consult: 1 TP (should_consult), 1 FP (should not) → 0.5
    const rows: Row[] = [
      { item: item({ should_consult: true }), mechanical: mech(true) }, // TP
      { item: item({ should_consult: false }), mechanical: mech(true) }, // FP
      { item: item({ should_consult: true }), mechanical: mech(false) }, // FN, not predicted
      { item: item({ should_consult: false }), mechanical: mech(false) }, // TN
    ];
    expect(consultPrecision(rows)).toBeCloseTo(0.5);
  });

  it('throws on empty input', () => {
    expect(() => consultPrecision([])).toThrow();
  });
});

describe('consultRecall', () => {
  it('computes TP / (TP + FN)', () => {
    // 2 should_consult: 1 consulted (TP), 1 not (FN) → 0.5
    const rows: Row[] = [
      { item: item({ should_consult: true }), mechanical: mech(true) }, // TP
      { item: item({ should_consult: true }), mechanical: mech(false) }, // FN
      { item: item({ should_consult: false }), mechanical: mech(true) }, // FP, irrelevant to recall
    ];
    expect(consultRecall(rows)).toBeCloseTo(0.5);
  });

  it('throws on empty input', () => {
    expect(() => consultRecall([])).toThrow();
  });
});

describe('injectActionRate', () => {
  it('fraction of should_inject items where acted', () => {
    // 3 should_inject: 2 acted → 2/3
    const rows: Row[] = [
      { item: item({ should_inject: true }), mechanical: mech(false, true) },
      { item: item({ should_inject: true }), mechanical: mech(false, true) },
      { item: item({ should_inject: true }), mechanical: mech(false, false) },
      { item: item({ should_inject: false }), mechanical: mech(false, true) }, // ignored
    ];
    expect(injectActionRate(rows)).toBeCloseTo(2 / 3);
  });

  it('throws on empty input', () => {
    expect(() => injectActionRate([])).toThrow();
  });
});

describe('nearBoundaryFpRate', () => {
  it('fraction of negative near-boundary items wrongly consulted or acted', () => {
    // near_boundary items with should_consult=false AND should_inject=false:
    // 4 of them; 1 wrongly consulted, 1 wrongly acted → 2/4 = 0.5
    const rows: Row[] = [
      {
        item: item({ stratum: 'near_boundary', should_consult: false, should_inject: false }),
        mechanical: mech(true, false), // FP via consult
      },
      {
        item: item({ stratum: 'near_boundary', should_consult: false, should_inject: false }),
        mechanical: mech(false, true), // FP via act
      },
      {
        item: item({ stratum: 'near_boundary', should_consult: false, should_inject: false }),
        mechanical: mech(false, false), // clean
      },
      {
        item: item({ stratum: 'near_boundary', should_consult: false, should_inject: false }),
        mechanical: mech(false, false), // clean
      },
      // excluded: positive label
      {
        item: item({ stratum: 'near_boundary', should_consult: true, should_inject: false }),
        mechanical: mech(true, false),
      },
      // excluded: not near_boundary
      {
        item: item({ stratum: 'normal', should_consult: false, should_inject: false }),
        mechanical: mech(true, true),
      },
    ];
    expect(nearBoundaryFpRate(rows)).toBeCloseTo(0.5);
  });

  it('throws on empty input', () => {
    expect(() => nearBoundaryFpRate([])).toThrow();
  });
});
