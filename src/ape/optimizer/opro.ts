/**
 * 285/T016: OPRO rewriter (Opus) — proposes better prompt variants.
 *
 * OPRO (Optimization by PROmpting, arXiv 2309.03409): feed the model the current
 * prompt plus a structured summary of how it scored, and ask it to write better
 * candidates. Here the "score" is the EvalSummary (consult precision/recall,
 * inject-action rate, near-boundary false-positive rate) plus concrete failing
 * examples, so the rewriter knows exactly which prompts the current text mishandles.
 *
 * `OproRewriter` implements `Optimizer.propose`: it calls the rewriter model
 * (Opus, via an injected `callGateway`-shaped function so the optimizer stays
 * offline and testable), parses an N-element JSON array of candidate texts, and
 * returns `PromptVariant`s on the SAME surface with fresh ids. A malformed model
 * output yields an empty array — never thrown (mirrors corpus/label.ts robustness;
 * a flaky rewriter must degrade gracefully so the loop can keep its best-so-far).
 */

import type { EvalSummary, Optimizer, PromptVariant } from '../types.js';
import type { GatewayResult, GatewayRequest } from '../llm/gateway-client.js';

/** Injectable model call — same shape as `callGateway`. */
export type RewriterLlm = (req: GatewayRequest) => Promise<GatewayResult>;

const REWRITER_MODEL = 'anthropic/claude-opus-4-8' as const;

/** Default number of candidates to request per round. */
const DEFAULT_N = 4;

/**
 * The OPRO rewriter instructions. The model receives the current prompt and its
 * measured feedback, and must reply with ONLY a JSON array of candidate texts.
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

/** Render the feedback into a compact, stable score report + failing examples. */
function renderFeedback(current: PromptVariant, feedback: EvalSummary): string {
  const examples = feedback.failingExamples
    .map((e) => `- prompt: ${e.prompt} | expected: ${e.expected} | got: ${e.got}`)
    .join('\n');
  return [
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
    examples || '(none)',
  ].join('\n');
}

export class OproRewriter implements Optimizer {
  constructor(
    private readonly llm: RewriterLlm,
    private readonly n: number = DEFAULT_N,
  ) {}

  async propose(current: PromptVariant, feedback: EvalSummary): Promise<PromptVariant[]> {
    const user = [
      renderFeedback(current, feedback),
      '',
      `Produce ${this.n} candidate prompts.`,
    ].join('\n');

    const res = await this.llm({
      model: REWRITER_MODEL,
      system: OPRO_SYSTEM,
      messages: [{ role: 'user', content: user }],
      maxTokens: 1024,
      temperature: 0.7,
    });

    const arr = parseArray(res.text);
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
}
