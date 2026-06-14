/**
 * 285/RT7: OPRO rewriter — brief-builder + candidate-parser.
 *
 * OPRO (Optimization by PROmpting, arXiv 2309.03409): feed the model the current
 * prompt plus a structured summary of how it scored, and ask it to write better
 * candidates. Here the "score" is the EvalSummary (consult precision/recall,
 * inject-action rate, near-boundary false-positive rate) plus concrete failing
 * examples, so the rewriter knows exactly which prompts the current text mishandles.
 *
 * Per the 2026-06-14 pivot (design.md §3), the LLM call is NOT made here. The
 * rewriter subagent (Opus) is spawned by the in-session orchestration; TS keeps
 * the two PURE halves —
 *  - `buildRewriterBrief(current, feedback)` assembles a STABLE OPRO system
 *    prefix (`OPRO_SYSTEM` — byte-identical across calls so the subagent prompt
 *    prefix caches) followed by the current prompt + score report + failing
 *    examples, returned as one string the orchestration hands to the subagent;
 *  - `parseCandidates(raw, current)` interprets the subagent's reply → an array
 *    of `PromptVariant`s on the SAME surface with fresh ids. Malformed output
 *    yields an empty array — never thrown (mirrors corpus/label.ts robustness;
 *    a flaky rewriter must degrade gracefully so the loop keeps its best-so-far).
 */

import type { EvalSummary, PromptVariant } from '../types.js';

/**
 * STABLE OPRO system prefix — instructions only. MUST be byte-identical across
 * every call so the subagent prompt prefix caches. The current prompt + its
 * measured feedback go in the per-call delta appended by `buildRewriterBrief`.
 *
 * The model receives the current prompt and its score report, and must reply
 * with ONLY a JSON array of candidate texts.
 */
export const OPRO_SYSTEM = [
  'You are a prompt optimizer. You are given the CURRENT prompt for a',
  'team-knowledge gate (either a tool description that should make a coding agent',
  'consult the team brain, or an injection preamble that should make it act on',
  'injected team context), plus a SCORE REPORT showing how that prompt performed',
  'and concrete FAILING EXAMPLES it mishandled.',
  '',
  'Your job: write better candidate prompts that would raise consult precision and',
  'recall and inject-action rate WITHOUT raising the near-boundary false-positive',
  'rate (do not make the agent consult on translation / chit-chat / trivial work).',
  'Each candidate must serve the same surface as the current prompt.',
  '',
  'Respond with ONLY a JSON array and nothing else, each element:',
  '{"text":string}. Produce exactly the requested number of distinct candidates.',
].join('\n');

/**
 * Build the rewriter brief from the current variant + its EvalSummary feedback.
 *
 * The stable `OPRO_SYSTEM` prefix is followed by the surface, the current prompt
 * text (so the rewriter knows what it is improving), a compact score report, and
 * the concrete failing examples the current prompt mishandled.
 */
export function buildRewriterBrief(current: PromptVariant, feedback: EvalSummary): string {
  const examples =
    feedback.failingExamples
      .map((e) => `- prompt: ${e.prompt} | expected: ${e.expected} | got: ${e.got}`)
      .join('\n') || '(none)';

  return [
    OPRO_SYSTEM,
    '',
    `SURFACE: ${current.surface}`,
    `CURRENT PROMPT: ${current.text}`,
    '',
    'SCORE REPORT:',
    `- consultPrecision: ${feedback.consultPrecision}`,
    `- consultRecall: ${feedback.consultRecall}`,
    `- injectActionRate: ${feedback.injectActionRate}`,
    `- nearBoundaryFpRate: ${feedback.nearBoundaryFpRate}`,
    '',
    'FAILING EXAMPLES:',
    examples,
  ].join('\n');
}

/** Extract the first JSON array from model text. Null on parse failure. */
function parseArray(text: string): unknown[] | null {
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) return null;
  try {
    const arr = JSON.parse(match[0]);
    return Array.isArray(arr) ? arr : null;
  } catch {
    return null;
  }
}

/**
 * Parse the rewriter reply into candidate variants on `current`'s surface.
 *
 * Reads the first JSON array of `{ text: string }` objects; each becomes a
 * `PromptVariant` keeping `current.surface` with a fresh distinct id. Elements
 * missing a string `text` are skipped. Malformed output (no array / bad JSON /
 * non-array JSON) yields `[]` — never thrown, so a flaky rewriter degrades
 * gracefully (021 robustness: the loop keeps its best-so-far on a bad round).
 */
export function parseCandidates(raw: string, current: PromptVariant): PromptVariant[] {
  const arr = parseArray(raw);
  if (!arr) return [];

  const candidates: PromptVariant[] = [];
  for (let i = 0; i < arr.length; i++) {
    const el = arr[i] as Record<string, unknown> | null;
    if (!el || typeof el.text !== 'string') continue;
    candidates.push({
      id: `${current.id}-opro-${i}`,
      surface: current.surface,
      text: el.text,
    });
  }
  return candidates;
}
