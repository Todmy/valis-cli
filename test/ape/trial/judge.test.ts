/**
 * 285/RT6: cascade judge — brief-builder + score-parser.
 *
 * Reshaped from the LLM-calling `judgeQuality` to the two PURE halves used by
 * the in-session orchestration (design.md §3, amended 2026-06-14):
 *  - `buildJudgeBrief(scenario, trial, axis)` assembles the judge brief — a
 *    STABLE rubric prefix (byte-identical across calls so the subagent prompt
 *    prefix caches) + the minimal-output instruction + the per-trial varying
 *    delta (axis, task, output);
 *  - `parseJudgeScore(raw)` parses a bare 0..1 number, throwing (fail-loud) on
 *    verbose or out-of-range output.
 *
 * Mechanical labels (consulted / acted) are NOT judged here — the cascade keeps
 * them free; only the quality axes reach the judge subagent.
 */
import { describe, it, expect } from 'vitest';
import {
  buildJudgeBrief,
  parseJudgeScore,
  JUDGE_SYSTEM,
} from '../../../src/ape/trial/judge.js';
import type { ApeScenario } from '../../../src/ape/corpus/schema.js';
import type { TrialResult } from '../../../src/ape/types.js';

const scenario: ApeScenario = {
  id: 'scn-1',
  turns: ['How did we decide to handle auth tokens?'],
  should_consult: true,
  should_inject: false,
  stratum: 'normal',
  label_source: 'llm_proposed',
  needs_human_confirm: true,
};

const trial: TrialResult = {
  itemId: 'scn-1',
  variantId: 'variant-1',
  mechanical: { consulted: true, acted: false },
  rawOutput: 'I will search the team decision history for auth-token handling.',
};

describe('parseJudgeScore', () => {
  it('parses bare numeric score', () => {
    expect(parseJudgeScore('0.15')).toBeCloseTo(0.15);
  });

  it('rejects verbose output (throws)', () => {
    expect(() => parseJudgeScore('The score is 0.8 because the agent acted well.')).toThrow();
  });

  it('rejects out-of-range output (throws)', () => {
    expect(() => parseJudgeScore('1.5')).toThrow();
  });
});

describe('buildJudgeBrief', () => {
  it('rubric prefix is stable (byte-identical) across calls', () => {
    const a = buildJudgeBrief(scenario, trial, 'consult');
    const b = buildJudgeBrief(scenario, trial, 'inject');
    expect(a.system).toBe(b.system);
    expect(a.system).toBe(JUDGE_SYSTEM);
  });

  it('carries the per-trial delta (axis, task, output)', () => {
    const brief = buildJudgeBrief(scenario, trial, 'consult');
    expect(brief.user).toContain('consult');
    expect(brief.user).toContain(scenario.turns[0]);
    expect(brief.user).toContain(trial.rawOutput);
  });

  it('caps output low (single-number reply)', () => {
    const brief = buildJudgeBrief(scenario, trial, 'consult');
    expect(brief.maxTokens).toBeLessThanOrEqual(8);
  });
});
