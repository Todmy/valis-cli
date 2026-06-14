/**
 * 285/RT7: OPRO rewriter — brief-builder + candidate-parser.
 *
 * Reshaped from the LLM-calling `OproRewriter` to the two PURE halves used by
 * the in-session orchestration (design.md §3, amended 2026-06-14):
 *  - `buildRewriterBrief(current, feedback)` assembles the rewriter brief — a
 *    STABLE OPRO system prefix (byte-identical across calls so the subagent
 *    prompt prefix caches) followed by the current prompt + score report +
 *    concrete FAILING EXAMPLES, returned as a single string the orchestration
 *    hands to a rewriter (Opus) subagent;
 *  - `parseCandidates(raw, current)` parses an N-element JSON array of candidate
 *    texts into `PromptVariant`s on the SAME surface with fresh ids; malformed
 *    output yields an empty array (never thrown) so a flaky rewriter degrades
 *    gracefully and the loop keeps its best-so-far.
 *
 * No network / LLM call here — RT1 removed the Gateway layer.
 */
import { describe, it, expect } from 'vitest';
import {
  buildRewriterBrief,
  parseCandidates,
  OPRO_SYSTEM,
} from '../../../src/ape/optimizer/opro.js';
import type { EvalSummary, PromptVariant } from '../../../src/ape/types.js';

const current: PromptVariant = {
  id: 'baseline',
  surface: 'pull_tool_description',
  text: "Search the team's shared decision history",
};

const feedback: EvalSummary = {
  consultPrecision: 0.5,
  consultRecall: 0.4,
  injectActionRate: 0.6,
  nearBoundaryFpRate: 0.3,
  failingExamples: [
    { prompt: 'implement the PRD for auth', expected: 'consult', got: 'no consult' },
  ],
};

describe('buildRewriterBrief', () => {
  it('brief includes failing examples', () => {
    const brief = buildRewriterBrief(current, feedback);
    expect(brief).toContain('implement the PRD for auth');
    // Current prompt text is carried so the rewriter knows what it is improving.
    expect(brief).toContain("Search the team's shared decision history");
    // Score report numbers surface so the rewriter knows how it performed.
    expect(brief).toContain('0.5');
  });

  it('starts with the stable OPRO_SYSTEM prefix', () => {
    const brief = buildRewriterBrief(current, feedback);
    expect(brief.startsWith(OPRO_SYSTEM)).toBe(true);
  });

  it('OPRO_SYSTEM instructs a JSON-array reply', () => {
    expect(OPRO_SYSTEM.toLowerCase()).toContain('json array');
  });
});

describe('parseCandidates', () => {
  it('parses N candidates keeping the surface, new distinct ids', () => {
    const raw = JSON.stringify([
      { text: 'Search the team brain before acting' },
      { text: 'Consult prior team decisions for this task' },
    ]);
    const candidates = parseCandidates(raw, current);
    expect(candidates).toHaveLength(2);
    for (const c of candidates) {
      expect(c.surface).toBe('pull_tool_description');
      expect(c.id).not.toBe(current.id);
      expect(typeof c.text).toBe('string');
    }
    expect(new Set(candidates.map((c) => c.id)).size).toBe(candidates.length);
  });

  it('skips elements missing a text field', () => {
    const raw = JSON.stringify([{ text: 'good' }, { notText: 'bad' }, { text: 'also good' }]);
    const candidates = parseCandidates(raw, current);
    expect(candidates).toHaveLength(2);
    expect(candidates.map((c) => c.text)).toEqual(['good', 'also good']);
  });

  it('malformed model output → empty array, no throw', () => {
    expect(parseCandidates('not a json array at all', current)).toEqual([]);
  });

  it('non-array JSON → empty array, no throw', () => {
    expect(parseCandidates('{"text":"single object not array"}', current)).toEqual([]);
  });
});
