/**
 * 045 Find Gaps — epistemic markers for programmatic hypotheses (FR-026).
 *
 * The run path NEVER auto-stores anything (FR-025) — closing decisions are
 * user-authored normal records (FR-022). But IF a generated hypothesis is ever
 * stored programmatically (a future path), it MUST be unmistakable as an
 * unverified guess. `toGapFillDraft` stamps all FOUR markers:
 *   1. status = 'proposed'        (never active — promotion is a human step)
 *   2. confidence 0.3–0.4         (low — a guess, not a recorded decision)
 *   3. `[GAP-FILL/HYP]` summary prefix
 *   4. a provenance trailer       (method / source / date / verify-note)
 *
 * `date` is caller-supplied (ISO) so the output is deterministic and testable.
 */

export const GAP_FILL_PREFIX = '[GAP-FILL/HYP]';
/** Within the FR-026 band [0.3, 0.4]. */
export const GAP_FILL_CONFIDENCE = 0.35;

export interface GapFillDraft {
  text: string;
  summary: string;
  type: 'decision' | 'constraint' | 'pattern' | 'lesson';
  affects: string[];
  confidence: number;
  status: 'proposed';
}

export function toGapFillDraft(input: {
  component: string;
  question: string;
  hypothesis: string;
  /** ISO date string — provenance trailer. */
  date: string;
}): GapFillDraft {
  const summary = `${GAP_FILL_PREFIX} ${input.question.replace(/\?+$/, '').trim()}`.slice(0, 200);

  const trailer = [
    '',
    '---',
    'method: find-gaps hypothesis (programmatic)',
    `source: gap question for component "${input.component}"`,
    `date: ${input.date}`,
    'verify: unverified hypothesis — confirm against reality before promoting',
  ].join('\n');

  return {
    text: `${input.hypothesis}${trailer}`,
    summary,
    type: 'lesson',
    affects: [input.component],
    confidence: GAP_FILL_CONFIDENCE,
    status: 'proposed',
  };
}
