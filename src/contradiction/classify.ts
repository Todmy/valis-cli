/**
 * 044/T003-T005: opposition classifier — the gate's stage-1 verdict (path C).
 *
 * Decides whether two short team decisions genuinely OPPOSE (vs merely share a
 * topic). On path C this is a hardened Haiku call (no NLI cross-encoder yet —
 * that is deferred to #284). Hardening per research R3:
 *   - conflict-framed prompt (knowledge-conflict definition + the labels);
 *   - SYMMETRIC label set — the model classifies the relationship TYPE, never
 *     the direction. Supersession direction is decided downstream from metadata
 *     (newer decision wins — Graphiti recency), so a two-pass (a,b)/(b,a) is
 *     meaningful for every label and disagreement is a real abstain signal;
 *   - temperature 0, tiny max_tokens, structured JSON output.
 *
 * Non-throwing (Constitution IV — no LLM dependency for core ops): EVERY
 * failure — no API key, network error, timeout, parse error, two-pass
 * disagreement — resolves to an `uncertain` abstention, never rejects. The
 * store write must succeed regardless.
 */

const DEFAULT_ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';

/**
 * Resolve the Anthropic Messages endpoint. Self-hosters routing through a
 * gateway/proxy override it via `ANTHROPIC_BASE_URL` (the base — `/v1/messages`
 * is appended). Defaults to the public Anthropic API so hosted behaviour is
 * unchanged.
 */
function anthropicApiUrl(): string {
  const base = process.env.ANTHROPIC_BASE_URL?.trim();
  if (!base) return DEFAULT_ANTHROPIC_API_URL;
  return `${base.replace(/\/+$/, '')}/v1/messages`;
}

const MODEL = 'claude-3-5-haiku-latest';
const MAX_TOKENS = 60;
const DEFAULT_TIMEOUT_MS = 1500;

export interface DecisionLite {
  id: string;
  summary: string | null;
  detail: string;
}

export type OppositionClass =
  | 'replacement'
  | 'genuine_conflict'
  | 'compatible'
  | 'uncertain';

export interface OppositionVerdict {
  classification: OppositionClass;
  /** 0–1. Always 0 when abstained. */
  confidence: number;
  /** true ⇒ classification is 'uncertain' (unavailable / error / disagreement). */
  abstained: boolean;
  /** Short rationale for audit/telemetry only. */
  reason?: string;
}

export type OppositionClassifier = (
  a: DecisionLite,
  b: DecisionLite,
) => Promise<OppositionVerdict>;

export interface HaikuClassifierOptions {
  /** Absent ⇒ every call abstains (stdio mode / no creds). */
  apiKey?: string;
  /** Per-pass hard timeout. Default 1500ms. */
  timeoutMs?: number;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

/** Symmetric label the model is asked to return (direction decided downstream). */
type RawLabel = 'compatible' | 'genuine_conflict' | 'replacement';

const SYSTEM_PROMPT = [
  'You classify the RELATIONSHIP between two short team decisions (A and B) that are already known to share a topic.',
  'Two claims CONFLICT iff they cannot both be true at the same time (logically: A ∧ B = False).',
  'Choose exactly one label (about the relationship TYPE only — do NOT pick a direction):',
  '- "compatible": same topic but NOT opposing — they agree, complement, or simply discuss different aspects. This is the DEFAULT; choose it unless there is clear opposition.',
  '- "genuine_conflict": they assert opposing things about the same subject (one negates or contradicts the other).',
  '- "replacement": one states a new direction that supersedes/replaces the other (a temporal change of mind, e.g. "we dropped X, moving to Y" vs an earlier "use X").',
  'Respond with ONLY a compact JSON object and nothing else: {"label":"compatible|genuine_conflict|replacement","confidence":0.0-1.0}.',
].join('\n');

function abstain(reason: string): OppositionVerdict {
  return { classification: 'uncertain', confidence: 0, abstained: true, reason };
}

function decisionText(d: DecisionLite): string {
  const head = d.summary && d.summary.trim().length > 0 ? d.summary.trim() : '';
  // Keep the body bounded — a verdict needs the claim, not the whole document.
  const body = d.detail.replace(/\s+/g, ' ').trim().slice(0, 600);
  return head ? `${head}\n${body}` : body;
}

/** One Haiku round-trip. Returns null on ANY failure (caller turns it into an abstain). */
async function classifyOnce(
  opts: Required<Pick<HaikuClassifierOptions, 'apiKey' | 'timeoutMs' | 'fetchImpl'>>,
  first: DecisionLite,
  second: DecisionLite,
): Promise<{ label: RawLabel; confidence: number } | null> {
  const userContent = `A:\n${decisionText(first)}\n\nB:\n${decisionText(second)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  try {
    const res = await opts.fetchImpl(anthropicApiUrl(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': opts.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        temperature: 0,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userContent }],
      }),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
    const text =
      data.content?.filter((c) => c.type === 'text').map((c) => c.text ?? '').join('') ?? '';
    return parseLabel(text);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Extract {label, confidence} from the model text. Tolerant of surrounding prose. */
export function parseLabel(text: string): { label: RawLabel; confidence: number } | null {
  const match = text.match(/\{[^}]*\}/);
  if (!match) return null;
  let obj: { label?: unknown; confidence?: unknown };
  try {
    obj = JSON.parse(match[0]);
  } catch {
    return null;
  }
  const label = obj.label;
  if (label !== 'compatible' && label !== 'genuine_conflict' && label !== 'replacement') {
    return null;
  }
  let confidence = typeof obj.confidence === 'number' ? obj.confidence : 0.5;
  if (!Number.isFinite(confidence)) confidence = 0.5;
  confidence = Math.min(1, Math.max(0, confidence));
  return { label, confidence };
}

/**
 * Build a path-C opposition classifier. See module header for the contract.
 * Two passes (a,b) and (b,a); symmetric label; disagreement ⇒ abstain.
 */
export function makeHaikuClassifier(opts: HaikuClassifierOptions): OppositionClassifier {
  const apiKey = opts.apiKey;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl = opts.fetchImpl ?? fetch;

  return async (a, b) => {
    if (!apiKey) return abstain('no_classifier');
    const resolved = { apiKey, timeoutMs, fetchImpl };
    const [p1, p2] = await Promise.all([
      classifyOnce(resolved, a, b),
      classifyOnce(resolved, b, a),
    ]);
    if (!p1 || !p2) return abstain('classifier_error');

    // Symmetric labels ⇒ the two passes should agree. Disagreement on the
    // safe-vs-conflict boundary is the dangerous case → abstain.
    if (p1.label !== p2.label) {
      return abstain('pass_disagreement');
    }
    const confidence = (p1.confidence + p2.confidence) / 2;
    return { classification: p1.label, confidence, abstained: false };
  };
}
