/**
 * 285/RT4: pull-axis trial — brief-builder + decision-parser.
 *
 * The pull trial is split into its two PURE halves (the LLM call is a subagent
 * the orchestration layer spawns, not TS):
 *  - `buildPullBrief(scenario, variant)` builds a `WorkerBrief` carrying the
 *    multi-turn context, the final decision turn (last), the candidate
 *    `valis_search`/`valis_context` description as available tools, and a
 *    structured-output schema `{ would_consult, tool }`.
 *  - `parsePullDecision(raw)` reads the worker's structured decision → `{ consulted }`,
 *    failing loud on unparseable input.
 *
 * No network/LLM call lives here — these are deterministic, no mocks needed.
 */
import { describe, it, expect } from 'vitest';
import { buildPullBrief, parsePullDecision } from '../../../src/ape/trial/pull.js';
import type { ApeScenario } from '../../../src/ape/corpus/schema.js';
import type { PromptVariant } from '../../../src/ape/types.js';

const scenario: ApeScenario = {
  id: 'scn-1',
  turns: [
    'We are executing the auth PRD.',
    'Now wire up the token refresh path.',
    'How did we decide to handle auth tokens?',
  ],
  should_consult: true,
  should_inject: false,
  stratum: 'normal',
  label_source: 'llm_proposed',
  needs_human_confirm: true,
};

const variant: PromptVariant = {
  id: 'variant-1',
  surface: 'pull_tool_description',
  text: 'UNIQUE-DESC-MARKER search the team decision history before acting',
};

describe('buildPullBrief', () => {
  it('brief carries variant description + all turns', () => {
    const brief = buildPullBrief(scenario, variant);
    // every turn is represented in the brief
    for (const turn of scenario.turns) {
      expect(brief.context.includes(turn) || brief.decisionTurn === turn).toBe(true);
    }
    // the candidate description is offered as an available valis tool
    const valisTool = brief.tools.find((t) => t.name.includes('valis_search'));
    expect(valisTool).toBeDefined();
    expect(valisTool!.description).toBe(variant.text);
  });

  it('decision turn is last', () => {
    const brief = buildPullBrief(scenario, variant);
    expect(brief.decisionTurn).toBe(scenario.turns[scenario.turns.length - 1]);
  });

  it('exposes a structured-output schema with would_consult + tool', () => {
    const brief = buildPullBrief(scenario, variant);
    expect(brief.schema).toContain('would_consult');
    expect(brief.schema).toContain('tool');
  });

  it('single-turn scenario: decision turn is the only turn, no prior context', () => {
    const single: ApeScenario = { ...scenario, turns: ['What is auth?'] };
    const brief = buildPullBrief(single, variant);
    expect(brief.decisionTurn).toBe('What is auth?');
    expect(brief.context).toBe('');
  });
});

describe('parsePullDecision', () => {
  it('parses {would_consult:true}', () => {
    const { consulted } = parsePullDecision('{"would_consult": true, "tool": "valis_search"}');
    expect(consulted).toBe(true);
  });

  it('parses {would_consult:false}', () => {
    const { consulted } = parsePullDecision('{"would_consult": false, "tool": null}');
    expect(consulted).toBe(false);
  });

  it('tolerates an already-parsed object', () => {
    const { consulted } = parsePullDecision({ would_consult: true });
    expect(consulted).toBe(true);
  });

  it('malformed → throws', () => {
    expect(() => parsePullDecision('not json at all')).toThrow();
  });

  it('missing would_consult → throws', () => {
    expect(() => parsePullDecision('{"tool": "valis_search"}')).toThrow();
  });
});
