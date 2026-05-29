/**
 * 034-unified-capture-policy / FR-004: content-based decision-type classifier.
 *
 * Deterministic, client-side, no LLM. Match priority: decision → constraint
 * → pattern → default lesson. The contract is documented in
 * specs/034-unified-capture-policy/contracts/mcp-valis-store.md.
 *
 * Constitution alignment: Principle IV ("No LLM Dependency for Core Ops").
 *
 * Accuracy target: ≥80% on a 30-fixture corpus (SC-005). See
 * test/lib/type-inference.test.ts.
 */

export type InferredDecisionType = 'decision' | 'constraint' | 'pattern' | 'lesson';

export interface InferenceResult {
  type: InferredDecisionType;
  /** true when a non-default pattern matched. false ⇒ fell through to `lesson`. */
  matched: boolean;
}

// Patterns are case-insensitive, word-bounded where the boundary matters.
// Each tier is OR-of-regexes; first tier with a match wins.
const DECISION_PATTERNS: readonly RegExp[] = [
  /\b(chose|chosen|decided|decide|picked|selecting|selected|went with|going with|will use)\b/i,
  /\binstead of\b/i,
  /\b(use|using)\s+\w+\s+(because|since|so that|to avoid|to enable)\b/i,
  /\bswitched from\b/i,
];

const CONSTRAINT_PATTERNS: readonly RegExp[] = [
  /\b(must|cannot|can’t|can't|required to|blocked by)\b/i,
  /\b(legal|compliance|sla|contract|deadline|regulatory|gdpr|hipaa)\b/i,
  /\bclient\s+(requires|requested|asked|demands)\b/i,
  /\b(rate[- ]?limited|throttled at)\b/i,
];

const PATTERN_PATTERNS: readonly RegExp[] = [
  /\b(pattern|convention)\b/i,
  /\b(whenever|always|every time|each time|all of these)\b/i,
  /\b(when (writing|using|building|adding|creating|reading))\b/i,
  /\b(prefer|preferred)\s+\w+\s+over\b/i,
];

function anyMatch(haystack: string, patterns: readonly RegExp[]): boolean {
  for (const re of patterns) {
    if (re.test(haystack)) return true;
  }
  return false;
}

/**
 * Classify a decision from its `summary` + `detail` content. Returns one of
 * four canonical types plus a `matched` flag (true ⇒ a non-default tier
 * matched; false ⇒ default catch-all `lesson`).
 *
 * @param summary - optional short title; may be empty.
 * @param detail  - the long-form text. Required; empty input falls through
 *                  to `lesson` with matched=false.
 */
export function inferType(summary: string, detail: string): InferenceResult {
  const haystack = `${summary ?? ''}\n${detail ?? ''}`;

  if (anyMatch(haystack, DECISION_PATTERNS)) {
    return { type: 'decision', matched: true };
  }
  if (anyMatch(haystack, CONSTRAINT_PATTERNS)) {
    return { type: 'constraint', matched: true };
  }
  if (anyMatch(haystack, PATTERN_PATTERNS)) {
    return { type: 'pattern', matched: true };
  }
  return { type: 'lesson', matched: false };
}

/**
 * Derive a summary (≤100 chars) from `detail` when no explicit summary was
 * provided (FR-006). Trims whitespace; truncates silently with no ellipsis.
 */
export function deriveSummary(detail: string): string {
  if (!detail) return '';
  return detail.slice(0, 100).trim();
}

/**
 * Apply FR-004 / FR-005 / FR-006 / FR-007 defaults to a `valis_store` args
 * shape. Used by `handleStore` before constructing the `RawDecision` to
 * commit. The function never mutates its input; it returns the normalised
 * trio plus boolean flags that the response layer surfaces so callers can
 * detect (and override) silent inference.
 *
 * @param input - raw store args fields (only the inference-relevant ones).
 *
 * @returns Resolved fields plus `inferred_type` / `inferred_summary` flags.
 *   `inferred_*` is `true` iff the field was absent from input and the
 *   classifier or summary-deriver produced a value. When the caller passed
 *   the field explicitly, the flag is `false` and the value is preserved.
 */
export interface InferenceInput {
  type?: 'decision' | 'constraint' | 'pattern' | 'lesson';
  summary?: string;
  affects?: string[];
  text: string;
}

export interface InferenceOutput {
  type: 'decision' | 'constraint' | 'pattern' | 'lesson';
  summary: string;
  affects: string[];
  inferred_type: boolean;
  inferred_summary: boolean;
}

export function applyInferenceDefaults(input: InferenceInput): InferenceOutput {
  const explicitType = input.type != null;
  const explicitSummary = input.summary != null && input.summary.length > 0;

  let resolvedType: InferredDecisionType;
  if (explicitType) {
    resolvedType = input.type!;
  } else {
    resolvedType = inferType(input.summary ?? '', input.text).type;
  }

  const resolvedSummary = explicitSummary ? input.summary! : deriveSummary(input.text);
  const resolvedAffects = input.affects ?? [];

  return {
    type: resolvedType,
    summary: resolvedSummary,
    affects: resolvedAffects,
    inferred_type: !explicitType,
    inferred_summary: !explicitSummary,
  };
}
