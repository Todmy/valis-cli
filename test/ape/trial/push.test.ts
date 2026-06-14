/**
 * 285/RT5: push-axis trial — brief-builder + decision-parser.
 *
 * The push trial is split into its two PURE halves (the LLM call is a subagent
 * the orchestration layer spawns, not TS):
 *  - `buildPushBrief(scenario, variant)` composes the `<valis_search_results>`
 *    block via the REAL `composeSearchResultsBlock` serializer (NOT
 *    reimplemented), frames it with the candidate `variant.text`, prepends it to
 *    the decision turn (the last turn), and carries a structured-output schema
 *    `{ acts_on_injection }`.
 *  - `parsePushDecision(raw)` reads the worker's structured decision → `{ acted }`,
 *    failing loud on unparseable input.
 *
 * No network/LLM call lives here — these are deterministic, no mocks needed.
 */
import { describe, it, expect } from 'vitest';
import { buildPushBrief, parsePushDecision } from '../../../src/ape/trial/push.js';
import type { ApeScenario } from '../../../src/ape/corpus/schema.js';
import type { PromptVariant } from '../../../src/ape/types.js';

const scenario: ApeScenario = {
  id: 'scn-1',
  turns: [
    'We are executing the auth PRD.',
    'Now wire up the token refresh path.',
    'Add a new auth flow for the dashboard.',
  ],
  should_consult: false,
  should_inject: true,
  stratum: 'normal',
  label_source: 'llm_proposed',
  needs_human_confirm: true,
};

const variant: PromptVariant = {
  id: 'variant-1',
  surface: 'push_injection_template',
  text: 'UNIQUE-PREAMBLE-MARKER act on the team decisions below before coding',
};

describe('buildPushBrief', () => {
  it('composes <hit> block (not <result>)', () => {
    const brief = buildPushBrief(scenario, variant);
    expect(brief.decisionTurn).toContain('<valis_search_results');
    expect(brief.decisionTurn).toContain('<hit');
    expect(brief.decisionTurn).not.toContain('<result');
  });

  it('reuses real composeSearchResultsBlock (assert envelope shape)', () => {
    const brief = buildPushBrief(scenario, variant);
    // The real serializer emits these envelope attributes — a reimplementation
    // would not match byte-for-byte.
    expect(brief.decisionTurn).toContain('purpose="');
    expect(brief.decisionTurn).toContain('for_prompt="');
    expect(brief.decisionTurn).toContain('</valis_search_results>');
  });

  it('frames the block with the candidate variant.text and the last turn', () => {
    const brief = buildPushBrief(scenario, variant);
    expect(brief.decisionTurn).toContain(variant.text);
    // the actual ask (last turn) is present
    expect(brief.decisionTurn).toContain(scenario.turns[scenario.turns.length - 1]);
  });

  it('prior turns become context; decision turn is the last', () => {
    const brief = buildPushBrief(scenario, variant);
    expect(brief.context).toContain('We are executing the auth PRD.');
    expect(brief.context).toContain('Now wire up the token refresh path.');
    // the last turn is NOT duplicated into context
    expect(brief.context).not.toContain('Add a new auth flow for the dashboard.');
  });

  it('single-turn scenario: no prior context, block still framed', () => {
    const single: ApeScenario = { ...scenario, turns: ['Add a new auth flow.'] };
    const brief = buildPushBrief(single, variant);
    expect(brief.context).toBe('');
    expect(brief.decisionTurn).toContain('Add a new auth flow.');
    expect(brief.decisionTurn).toContain('<valis_search_results');
  });

  it('exposes a structured-output schema with acts_on_injection', () => {
    const brief = buildPushBrief(scenario, variant);
    expect(brief.schema).toContain('acts_on_injection');
  });

  it('offers a valis tool the worker can act with', () => {
    const brief = buildPushBrief(scenario, variant);
    const valisTool = brief.tools.find((t) => t.name.includes('valis_search'));
    expect(valisTool).toBeDefined();
  });
});

describe('parsePushDecision', () => {
  it('parses {acts_on_injection:true}', () => {
    const { acted } = parsePushDecision('{"acts_on_injection": true}');
    expect(acted).toBe(true);
  });

  it('parses {acts_on_injection:false}', () => {
    const { acted } = parsePushDecision('{"acts_on_injection": false}');
    expect(acted).toBe(false);
  });

  it('tolerates an already-parsed object', () => {
    const { acted } = parsePushDecision({ acts_on_injection: true });
    expect(acted).toBe(true);
  });

  it('malformed → throws', () => {
    expect(() => parsePushDecision('not json at all')).toThrow();
  });

  it('missing acts_on_injection → throws', () => {
    expect(() => parsePushDecision('{"other": true}')).toThrow();
  });
});
