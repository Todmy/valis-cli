/**
 * 285/T001: shape + compile-time assertions for the APE harness shared types.
 *
 * The module is a pure type surface (no runtime code). These tests construct a
 * literal of each interface and assert the required fields are present, which
 * doubles as a compile-time check that the exported shapes match the contract
 * in `docs/krukit/285-ape-harness/plan.md` Task 1.
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
  MechanicalLabels,
  JudgeScore,
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

  it('ApeCorpusItem allows omitting the optional source_session', () => {
    const item: ApeCorpusItem = {
      id: 'i2',
      prompt: 'just say hi',
      should_consult: false,
      should_inject: false,
      stratum: 'normal',
      label_source: 'human_confirmed',
      needs_human_confirm: false,
    };
    expect(item.source_session).toBeUndefined();
  });

  it('TrialResult carries mechanical + optional judge', () => {
    const mechanical: MechanicalLabels = { consulted: true, acted: false };
    const judge: JudgeScore[] = [{ axis: 'inject', score: 0.42 }];

    const withJudge: TrialResult = {
      itemId: 'i1',
      variantId: 'v1',
      mechanical,
      judge,
      rawOutput: 'the worker said something',
      costUsd: 0.0012,
    };
    const withoutJudge: TrialResult = {
      itemId: 'i1',
      variantId: 'v1',
      mechanical: { consulted: false, acted: false },
      rawOutput: 'plain answer',
      costUsd: 0,
    };

    expect(withJudge.mechanical.consulted).toBe(true);
    expect(withJudge.judge?.[0].axis).toBe('inject');
    expect(withJudge.judge?.[0].score).toBeCloseTo(0.42);
    expect(withoutJudge.judge).toBeUndefined();
    expect(withoutJudge.costUsd).toBe(0);
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
