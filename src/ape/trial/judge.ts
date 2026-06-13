/**
 * 285/T010: cascade Opus judge — minimal numeric output.
 *
 * The cascade splits scoring into two tiers: MECHANICAL labels (consulted /
 * acted) are free — they come from `adapter.detectToolCall` in the trial and
 * are NEVER judged here. Only the QUALITY axes that need a model go to Opus.
 *
 * `judgeQuality` calls Opus with a STABLE cache-prefixed system prompt
 * (`JUDGE_SYSTEM` — rubric + few-shot, byte-identical across every call so the
 * Gateway's prompt cache hits and re-reads bill at the cached-read rate) and a
 * minimal user delta (the trial output). The model is instructed to reply with
 * ONLY a bare number 0..1; we parse that number and throw (fail-loud) on any
 * non-numeric output — never silently coerce a bad reply to a default score.
 *
 * The `llm` call is injected so the judge stays a pure, offline orchestration:
 * the live AI Gateway wiring (opus, provider-pinned) lives in the orchestrator.
 */

import type { Axis, ApeCorpusItem, JudgeScore, TrialResult } from '../types.js';

/** Cap output hard — a single token reply ("0.15") is all the judge may emit. */
const JUDGE_MAX_TOKENS = 8;

/**
 * STABLE system prefix — rubric + few-shot. MUST be byte-identical across every
 * call (including across axes) so the Gateway caches the prefix. The axis and
 * the trial output go in the per-call USER turn, never here.
 */
export const JUDGE_SYSTEM = [
  'You are a strict evaluator scoring how well a coding agent handled team-knowledge context.',
  '',
  'You score ONE quality axis on a continuous scale from 0.0 to 1.0:',
  '- consult: did the agent appropriately CONSULT the team knowledge base when team',
  '  decisions could change its action? 1.0 = consulted exactly when warranted; 0.0 = ignored a',
  '  clear need to consult, or consulted gratuitously when no team decision was relevant.',
  '- inject: given injected team context, did the agent ACT on it? 1.0 = obeyed the injected',
  '  imperative and grounded its action in the context; 0.0 = ignored the injected context entirely.',
  '',
  'A prompt warrants consult/inject when team decisions could change the action (e.g. executing a',
  'PRD, picking an approach where a prior decision exists). Translation, chit-chat, and pure',
  'restating do NOT warrant it — scoring high there is a false positive.',
  '',
  'Examples:',
  'AXIS consult / TASK warrants consult / OUTPUT searched the decision history -> 0.95',
  'AXIS consult / TASK pure translation / OUTPUT searched the decision history -> 0.10',
  'AXIS inject / context injected / OUTPUT grounded its plan in the injected decision -> 0.90',
  'AXIS inject / context injected / OUTPUT ignored it and answered generically -> 0.05',
  '',
  'Reply with ONLY a single number between 0.0 and 1.0. No words, no explanation, no units.',
].join('\n');

/** The minimal request the judge hands to the injected Opus call. */
export interface JudgeRequest {
  system: string;
  messages: { role: 'user'; content: string }[];
  maxTokens: number;
  temperature: number;
}

/** Injectable Opus call — returns the raw text + cost. */
export type JudgeLlm = (req: JudgeRequest) => Promise<{ text: string; costUsd: number }>;

/** Parse a bare numeric reply in [0,1]; fail-loud on anything else. */
function parseScore(text: string): number {
  const trimmed = text.trim();
  if (!/^-?\d*\.?\d+$/.test(trimmed)) {
    throw new Error(`judge: non-numeric score reply: ${JSON.stringify(text.slice(0, 80))}`);
  }
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n < 0 || n > 1) {
    throw new Error(`judge: score out of range [0,1]: ${trimmed}`);
  }
  return n;
}

export async function judgeQuality(
  item: ApeCorpusItem,
  trial: TrialResult,
  axis: Axis,
  llm: JudgeLlm,
): Promise<JudgeScore> {
  // Minimal user delta — only the per-trial varying part. The stable rubric +
  // few-shot live in JUDGE_SYSTEM so the prefix caches across calls.
  const user = [
    `AXIS ${axis}`,
    `TASK ${item.prompt}`,
    `OUTPUT ${trial.rawOutput}`,
    'SCORE:',
  ].join('\n');

  const { text } = await llm({
    system: JUDGE_SYSTEM,
    messages: [{ role: 'user', content: user }],
    maxTokens: JUDGE_MAX_TOKENS,
    temperature: 0,
  });

  return { axis, score: parseScore(text) };
}
