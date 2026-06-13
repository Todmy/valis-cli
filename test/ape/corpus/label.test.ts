/**
 * 285/T007: Opus label proposer — ape/corpus/label.ts.
 *
 * proposeLabels(prompts, llm) calls the judge model (Opus, via callGateway) to
 * assign should_consult / should_inject / stratum per prompt, returning items
 * with label_source:'llm_proposed', needs_human_confirm:true.
 *
 * generateNearBoundary(clearItems, llm, n) asks Opus to produce near-boundary
 * variants (almost-valid / almost-invalid) of clear cases, tagged
 * stratum:'near_boundary', same confirm flag.
 *
 * The injected `llm` mirrors the `callGateway` signature — a function that
 * returns a GatewayResult whose `.text` carries the model's JSON output. No
 * live calls.
 */
import { describe, it, expect } from 'vitest';
import type { GatewayResult } from '../../../src/ape/llm/gateway-client.js';
import {
  proposeLabels,
  generateNearBoundary,
  LABEL_RUBRIC,
  type LabelLlm,
} from '../../../src/ape/corpus/label.js';
import type { MinedPrompt } from '../../../src/ape/corpus/mine.js';
import type { ApeCorpusItem } from '../../../src/ape/types.js';

/** Wrap a canned model text into a minimal GatewayResult. */
function result(text: string): GatewayResult {
  return { text, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, costUsd: 0 };
}

/** An llm that returns the same canned text for every call. */
const fixedLlm = (text: string): LabelLlm => async () => result(text);

/** An llm that returns scripted texts in sequence (per call). */
function scriptedLlm(texts: string[]): LabelLlm {
  let i = 0;
  return async () => result(texts[i++] ?? '');
}

const prompts: MinedPrompt[] = [
  { text: 'implement the PRD for the auth flow', sessionId: 's1' },
  { text: 'translate this comment to Ukrainian', sessionId: 's2' },
];

describe('proposeLabels', () => {
  it('assigns both axes from model output', async () => {
    const llm = scriptedLlm([
      '{"should_consult":true,"should_inject":true,"stratum":"normal"}',
      '{"should_consult":false,"should_inject":false,"stratum":"normal"}',
    ]);
    const items = await proposeLabels(prompts, llm);
    expect(items).toHaveLength(2);
    expect(items[0].should_consult).toBe(true);
    expect(items[0].should_inject).toBe(true);
    expect(items[0].prompt).toBe('implement the PRD for the auth flow');
    expect(items[1].should_consult).toBe(false);
    expect(items[1].should_inject).toBe(false);
  });

  it('marks needs_human_confirm and label_source', async () => {
    const llm = fixedLlm('{"should_consult":true,"should_inject":false,"stratum":"store"}');
    const items = await proposeLabels(prompts, llm);
    for (const it of items) {
      expect(it.label_source).toBe('llm_proposed');
      expect(it.needs_human_confirm).toBe(true);
      expect(it.source_session).toBeDefined();
    }
  });

  it('skips a malformed model output without throwing', async () => {
    const llm = scriptedLlm([
      'not json at all',
      '{"should_consult":false,"should_inject":false,"stratum":"normal"}',
    ]);
    const items = await proposeLabels(prompts, llm);
    // The malformed first item is skipped; the second survives.
    expect(items).toHaveLength(1);
    expect(items[0].prompt).toBe('translate this comment to Ukrainian');
  });

  it('rubric encodes the #290 gate semantics', () => {
    expect(LABEL_RUBRIC).toMatch(/change the agent's action/i);
    expect(LABEL_RUBRIC.toLowerCase()).toContain('prd');
    expect(LABEL_RUBRIC.toLowerCase()).toContain('translation');
  });
});

const clearItems: ApeCorpusItem[] = [
  {
    id: 'c1',
    prompt: 'implement the PRD for the auth flow',
    should_consult: true,
    should_inject: true,
    stratum: 'normal',
    label_source: 'llm_proposed',
    needs_human_confirm: true,
    source_session: 's1',
  },
];

describe('generateNearBoundary', () => {
  it('tags near_boundary and flags for confirm', async () => {
    const llm = fixedLlm(
      JSON.stringify([
        { prompt: 'fix the typo in the PRD heading', should_consult: false, should_inject: false },
        { prompt: 'apply the auth-flow decision we made last week', should_consult: true, should_inject: true },
      ]),
    );
    const items = await generateNearBoundary(clearItems, llm, 2);
    expect(items.length).toBeGreaterThan(0);
    for (const it of items) {
      expect(it.stratum).toBe('near_boundary');
      expect(it.label_source).toBe('llm_proposed');
      expect(it.needs_human_confirm).toBe(true);
    }
    expect(items.map((i) => i.prompt)).toContain('fix the typo in the PRD heading');
  });

  it('malformed model output → no items, not thrown', async () => {
    const llm = fixedLlm('garbage, not an array');
    const items = await generateNearBoundary(clearItems, llm, 3);
    expect(items).toEqual([]);
  });
});
