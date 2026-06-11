/**
 * 045/T031: knowledge-store integrity (US5, SC-007).
 *
 * `toGapFillDraft` must stamp all FOUR epistemic markers so a programmatically
 * stored hypothesis can never masquerade as verified team knowledge (FR-026).
 * The run-path "zero decisions writes" half of SC-007 is asserted in the web
 * executor test (decisionWrites === 0).
 */
import { describe, it, expect } from 'vitest';
import { toGapFillDraft, GAP_FILL_PREFIX } from '../../src/gaps/epistemic.js';

describe('toGapFillDraft — four epistemic markers (FR-026)', () => {
  const draft = toGapFillDraft({
    component: 'returns-refunds',
    question: 'How does the team handle returns and refunds?',
    hypothesis: 'A 30-day return window is likely appropriate for candles.',
    date: '2026-06-11',
  });

  it('marker 1 — status is proposed (never active)', () => {
    expect(draft.status).toBe('proposed');
  });

  it('marker 2 — confidence is in the low band [0.3, 0.4]', () => {
    expect(draft.confidence).toBeGreaterThanOrEqual(0.3);
    expect(draft.confidence).toBeLessThanOrEqual(0.4);
  });

  it('marker 3 — summary carries the [GAP-FILL/HYP] prefix', () => {
    expect(draft.summary.startsWith(GAP_FILL_PREFIX)).toBe(true);
  });

  it('marker 4 — body carries a provenance trailer (method/source/date/verify)', () => {
    expect(draft.text).toContain('method: find-gaps hypothesis');
    expect(draft.text).toContain('source: gap question for component "returns-refunds"');
    expect(draft.text).toContain('date: 2026-06-11');
    expect(draft.text).toContain('verify:');
  });

  it('tags the affected component', () => {
    expect(draft.affects).toEqual(['returns-refunds']);
  });
});
