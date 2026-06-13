/**
 * 285 APE harness — Opus label proposer + near-boundary generation (Task 7).
 *
 * Two LLM-backed corpus builders, both fed by the judge model (Opus) through an
 * injected `callGateway`-shaped function so trials stay testable and offline:
 *
 *   - proposeLabels(prompts, llm): for each mined prompt, ask Opus to assign the
 *     two gate axes (should_consult / should_inject) and a stratum. Every result
 *     is `label_source:'llm_proposed'`, `needs_human_confirm:true` — the gold-set
 *     MVP is LLM-proposed, hand-confirmed later (plan: bootstrap-40).
 *   - generateNearBoundary(clearItems, llm, n): ask Opus for almost-valid /
 *     almost-invalid variants of clear cases — the #290 boundary stratum — all
 *     tagged `stratum:'near_boundary'`, same confirm flag.
 *
 * Robustness (mirrors contradiction/classify.ts::parseLabel): a malformed model
 * output is SKIPPED (proposeLabels drops that item; generateNearBoundary returns
 * fewer / no items) — never thrown. The harness must survive a flaky judge.
 */

import type { ApeCorpusItem, Stratum } from '../types.js';
import type { GatewayResult, GatewayRequest } from '../llm/gateway-client.js';
import type { MinedPrompt } from './mine.js';

/** Injectable model call — same shape as `callGateway`. */
export type LabelLlm = (req: GatewayRequest) => Promise<GatewayResult>;

const JUDGE_MODEL = 'anthropic/claude-opus-4-8' as const;

/**
 * The labeling rubric — the #290 gate semantics. Positive `should_consult` /
 * `should_inject` means "a prompt where team decisions could change the agent's
 * action": PRD execution / architecture work YES; translation / chit-chat NO.
 */
export const LABEL_RUBRIC = [
  'You label developer prompts for a team-knowledge gate. For each prompt decide',
  'two booleans and a stratum.',
  '',
  'A prompt is POSITIVE (should_consult=true / should_inject=true) when team',
  "decisions could CHANGE THE AGENT'S ACTION on it — e.g. executing a PRD,",
  'implementing a feature, choosing an architecture, picking a library, or',
  'following an established convention. Consulting the team brain first would',
  'plausibly alter what the agent does.',
  '',
  'A prompt is NEGATIVE (both false) when no team decision could change the',
  'outcome — e.g. translation, summarisation, chit-chat, formatting a snippet,',
  'or a self-contained one-off with no project context.',
  '',
  'stratum: "store" if the prompt asks to record/remember a decision; otherwise',
  '"normal". (The "near_boundary" stratum is generated separately.)',
  '',
  'Respond with ONLY a compact JSON object and nothing else:',
  '{"should_consult":bool,"should_inject":bool,"stratum":"store|normal"}.',
].join('\n');

const NEAR_BOUNDARY_RUBRIC = [
  'You generate NEAR-BOUNDARY developer prompts to stress-test a team-knowledge',
  'gate. Given clear example prompts, produce variants that sit just on either',
  'side of the decision boundary: almost-valid (looks like it needs team',
  'decisions but does NOT) and almost-invalid (looks trivial but actually DOES).',
  '',
  'Positive means team decisions could change the agent\'s action (PRD execution,',
  'architecture). Negative means they could not (translation, formatting).',
  '',
  'Respond with ONLY a JSON array and nothing else, each element:',
  '{"prompt":string,"should_consult":bool,"should_inject":bool}.',
].join('\n');

/** Extract the first JSON object from model text. Null on parse failure. */
function parseObject(text: string): Record<string, unknown> | null {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const obj = JSON.parse(match[0]);
    return obj && typeof obj === 'object' ? (obj as Record<string, unknown>) : null;
  } catch {
    return null;
  }
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

function asStratum(value: unknown): Stratum {
  return value === 'store' ? 'store' : 'normal';
}

/**
 * Ask Opus to label each mined prompt. Items whose model output is malformed are
 * skipped (never thrown), so a flaky judge degrades gracefully.
 */
export async function proposeLabels(
  prompts: MinedPrompt[],
  llm: LabelLlm,
): Promise<ApeCorpusItem[]> {
  const items: ApeCorpusItem[] = [];
  for (let i = 0; i < prompts.length; i++) {
    const p = prompts[i];
    const res = await llm({
      model: JUDGE_MODEL,
      system: LABEL_RUBRIC,
      messages: [{ role: 'user', content: p.text }],
      maxTokens: 64,
      temperature: 0,
    });
    const obj = parseObject(res.text);
    if (
      !obj ||
      typeof obj.should_consult !== 'boolean' ||
      typeof obj.should_inject !== 'boolean'
    ) {
      continue;
    }
    items.push({
      id: `label-${i}`,
      prompt: p.text,
      should_consult: obj.should_consult,
      should_inject: obj.should_inject,
      stratum: asStratum(obj.stratum),
      label_source: 'llm_proposed',
      needs_human_confirm: true,
      source_session: p.sessionId,
    });
  }
  return items;
}

/**
 * Ask Opus for `n` near-boundary variants of the clear cases. Returns the
 * well-formed elements only; a malformed response yields an empty array.
 */
export async function generateNearBoundary(
  clearItems: ApeCorpusItem[],
  llm: LabelLlm,
  n: number,
): Promise<ApeCorpusItem[]> {
  const examples = clearItems
    .map(
      (it) =>
        `- "${it.prompt}" (consult=${it.should_consult}, inject=${it.should_inject})`,
    )
    .join('\n');
  const res = await llm({
    model: JUDGE_MODEL,
    system: NEAR_BOUNDARY_RUBRIC,
    messages: [
      {
        role: 'user',
        content: `Produce ${n} near-boundary variants. Clear examples:\n${examples}`,
      },
    ],
    maxTokens: 512,
    temperature: 0,
  });

  const arr = parseArray(res.text);
  if (!arr) return [];

  const items: ApeCorpusItem[] = [];
  for (let i = 0; i < arr.length; i++) {
    const el = arr[i] as Record<string, unknown> | null;
    if (
      !el ||
      typeof el.prompt !== 'string' ||
      typeof el.should_consult !== 'boolean' ||
      typeof el.should_inject !== 'boolean'
    ) {
      continue;
    }
    items.push({
      id: `near-${i}`,
      prompt: el.prompt,
      should_consult: el.should_consult,
      should_inject: el.should_inject,
      stratum: 'near_boundary',
      label_source: 'llm_proposed',
      needs_human_confirm: true,
    });
  }
  return items;
}
