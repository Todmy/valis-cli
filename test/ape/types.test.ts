/**
 * 285/T001 + RT9: shape + compile-time assertions for the APE harness shared types.
 *
 * The module is a pure type surface (no runtime code). These tests construct a
 * literal of each interface and assert the required fields are present, which
 * doubles as a compile-time check that the exported shapes match the contract.
 *
 * RT9 (re-plan v2): the canonical `ApeScenario`, `WorkerBrief`/`WorkerTool`, and
 * the call/token `Budget` types are PROMOTED here from their per-task modules,
 * and the USD types are DROPPED (`TrialResult.costUsd` gone; the legacy
 * `JudgeScore { axis, score }` removed — the judge now returns a bare number).
 */

import { describe, it, expect } from 'vitest';
// Runtime import forces vitest to resolve the module on disk (type-only imports
// are elided by the transform and would not fail when the module is missing).
import * as apeTypes from '../../src/ape/types.js';
import type {
  Axis,
  Stratum,
  LabelSource,
  ApeCorpusItem,
  ApeScenario,
  ScenarioMix,
  WorkerTool,
  WorkerBrief,
  BudgetCaps,
  Budget,
  MechanicalLabels,
  TrialResult,
  ParsedSession,
  PatchDescriptor,
  AgentAdapter,
  PromptVariant,
  Optimizer,
  EvalSummary,
} from '../../src/ape/types.js';

describe('ape/types', () => {
  it('module resolves (pure type surface, no runtime exports required)', () => {
    expect(apeTypes).toBeDefined();
  });

  it('ApeCorpusItem accepts both axes + stratum', () => {
    const axis: Axis = 'consult';
    const stratum: Stratum = 'near_boundary';
    const labelSource: LabelSource = 'llm_proposed';

    const item: ApeCorpusItem = {
      id: 'i1',
      prompt: 'implement the auth flow per our PRD',
      should_consult: true,
      should_inject: true,
      stratum,
      label_source: labelSource,
      needs_human_confirm: true,
      source_session: 'session-abc',
    };

    expect(item.id).toBe('i1');
    expect(item.should_consult).toBe(true);
    expect(item.should_inject).toBe(true);
    expect(item.stratum).toBe('near_boundary');
    expect(item.label_source).toBe('llm_proposed');
    expect(item.needs_human_confirm).toBe(true);
    expect(item.source_session).toBe('session-abc');
    // axis is part of the surface even though ApeCorpusItem does not carry it
    expect<Axis>(axis).toBe('consult');
  });

  it('ApeScenario carries multi-turn turns + decision labels', () => {
    const scenario: ApeScenario = {
      id: 's1',
      turns: ['set up the repo', 'now add the auth flow per our PRD'],
      should_consult: true,
      should_inject: true,
      stratum: 'normal',
      label_source: 'llm_proposed',
      needs_human_confirm: true,
      source_session: 'session-abc',
    };
    expect(scenario.turns).toHaveLength(2);
    expect(scenario.turns[scenario.turns.length - 1]).toContain('auth flow');
    expect(scenario.should_consult).toBe(true);
  });

  it('ScenarioMix maps length-bucket → count', () => {
    const mix: ScenarioMix = { 1: 3, 2: 2, 3: 1 };
    expect(mix[1]).toBe(3);
    expect(mix[3]).toBe(1);
  });

  it('WorkerBrief carries context + decisionTurn + tools + schema', () => {
    const tool: WorkerTool = {
      name: 'mcp__valis__valis_search',
      description: 'Search the team decision history',
      parameters: { type: 'object', properties: {}, required: [] },
    };
    const brief: WorkerBrief = {
      context: 'set up the repo',
      decisionTurn: 'now add the auth flow per our PRD',
      tools: [tool],
      schema: '{ "would_consult": boolean }',
    };
    expect(brief.tools[0].name).toBe('mcp__valis__valis_search');
    expect(brief.decisionTurn).toContain('auth flow');
    expect(brief.context).toBe('set up the repo');
  });

  it('Budget exposes addCall/calls/remaining/assertWithin over caps', () => {
    const caps: BudgetCaps = { maxCalls: 10, maxTokensEst: 1000 };
    const budget: Budget = {
      addCall: (_tokensEst: number): void => undefined,
      calls: (): number => 0,
      remaining: (): { calls: number; tokensEst: number } => ({
        calls: caps.maxCalls,
        tokensEst: caps.maxTokensEst,
      }),
      assertWithin: (): void => undefined,
    };
    expect(budget.calls()).toBe(0);
    expect(budget.remaining().calls).toBe(10);
    expect(budget.remaining().tokensEst).toBe(1000);
  });

  it('TrialResult carries mechanical + optional judge (no USD)', () => {
    const mechanical: MechanicalLabels = { consulted: true, acted: false };

    const withJudge: TrialResult = {
      itemId: 'i1',
      variantId: 'v1',
      mechanical,
      judge: [0.42],
      rawOutput: 'the worker said something',
    };
    const withoutJudge: TrialResult = {
      itemId: 'i1',
      variantId: 'v1',
      mechanical: { consulted: false, acted: false },
      rawOutput: 'plain answer',
    };

    expect(withJudge.mechanical.consulted).toBe(true);
    expect(withJudge.judge?.[0]).toBeCloseTo(0.42);
    expect(withoutJudge.judge).toBeUndefined();
  });

  it('ParsedSession records prompts with consulted/injected flags', () => {
    const session: ParsedSession = {
      sessionId: 's1',
      version: '1.0.0',
      prompts: [
        { text: 'do the thing', consulted: true, injected: false },
        { text: 'and another', consulted: false, injected: true },
      ],
    };
    expect(session.sessionId).toBe('s1');
    expect(session.version).toBe('1.0.0');
    expect(session.prompts).toHaveLength(2);
    expect(session.prompts[1].injected).toBe(true);
  });

  it('AgentAdapter has parseLog/detectToolCall/deployTarget', () => {
    const adapter: AgentAdapter = {
      parseLog: (_jsonl: string): ParsedSession => ({
        sessionId: 's',
        prompts: [],
      }),
      detectToolCall: (_workerResponse: unknown) => ({
        tool: 'valis_search',
        fired: true,
      }),
      deployTarget: (surface: PatchDescriptor['surface']): PatchDescriptor => ({
        surface,
        file: 'packages/cli/src/mcp/server.ts',
        anchor: 'some anchor',
      }),
    };

    const parsed = adapter.parseLog('');
    expect(parsed.sessionId).toBe('s');

    const call = adapter.detectToolCall({});
    expect(call.tool).toBe('valis_search');
    expect(call.fired).toBe(true);

    const target = adapter.deployTarget('pull_tool_description');
    expect(target.surface).toBe('pull_tool_description');
    expect(target.file).toBe('packages/cli/src/mcp/server.ts');
    expect(target.anchor).toBe('some anchor');
  });

  it('PatchDescriptor surface is one of the two real surfaces', () => {
    const pull: PatchDescriptor = {
      surface: 'pull_tool_description',
      file: 'packages/cli/src/mcp/server.ts',
      anchor: 'a',
    };
    const push: PatchDescriptor = {
      surface: 'push_injection_template',
      file: 'packages/cli/src/hooks/inject-block.ts',
      anchor: 'composeSearchResultsBlock',
    };
    expect(pull.surface).toBe('pull_tool_description');
    expect(push.surface).toBe('push_injection_template');
  });

  it('Optimizer.propose returns candidate PromptVariants', async () => {
    const variant: PromptVariant = {
      id: 'v1',
      surface: 'pull_tool_description',
      text: 'Search the team decision history',
    };
    const feedback: EvalSummary = {
      consultPrecision: 0.9,
      consultRecall: 0.8,
      injectActionRate: 0.7,
      nearBoundaryFpRate: 0.05,
      failingExamples: [
        { prompt: 'p', expected: 'consult', got: 'no-consult' },
      ],
    };

    const optimizer: Optimizer = {
      propose: async (current, _fb) => [
        { id: 'v2', surface: current.surface, text: 'better text' },
      ],
    };

    const candidates = await optimizer.propose(variant, feedback);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].surface).toBe('pull_tool_description');
    expect(feedback.failingExamples[0].expected).toBe('consult');
  });
});
