import { describe, it, expect } from 'vitest';
import { applyInferenceDefaults } from '../../src/lib/type-inference.js';

/**
 * 034 / US3 (T023 + T024 fused): contract test for the inference defaults
 * helper used by handleStore before raw-decision construction. Covers:
 *   - inference fires when type/summary absent
 *   - inferred_* flags carried back
 *   - explicit caller input bypasses inference (no silent overwrite)
 */

describe('applyInferenceDefaults', () => {
  it('infers type when omitted (T023 / FR-004)', () => {
    const out = applyInferenceDefaults({
      text: 'We chose PostgreSQL because of MVCC',
    });
    expect(out.type).toBe('decision');
    expect(out.inferred_type).toBe(true);
  });

  it('derives summary when omitted (T023 / FR-006)', () => {
    const text = 'Some long-form detail about a decision we made today.';
    const out = applyInferenceDefaults({ text });
    expect(out.summary).toBe(text);
    expect(out.inferred_summary).toBe(true);
  });

  it('defaults affects to empty list when omitted (T023 / FR-007)', () => {
    const out = applyInferenceDefaults({ text: 'whatever' });
    expect(out.affects).toEqual([]);
  });

  it('preserves explicit type — does NOT silently overwrite (T024)', () => {
    const out = applyInferenceDefaults({
      type: 'lesson',
      text: 'We chose PostgreSQL because of MVCC', // would infer "decision"
    });
    expect(out.type).toBe('lesson');
    expect(out.inferred_type).toBe(false);
  });

  it('preserves explicit summary — does NOT silently overwrite (T024)', () => {
    const out = applyInferenceDefaults({
      summary: 'caller-supplied title',
      text: 'long detail here',
    });
    expect(out.summary).toBe('caller-supplied title');
    expect(out.inferred_summary).toBe(false);
  });

  it('preserves explicit affects — does NOT default to [] (T024)', () => {
    const out = applyInferenceDefaults({
      text: 'whatever',
      affects: ['auth', 'payments'],
    });
    expect(out.affects).toEqual(['auth', 'payments']);
  });

  it('handles all-explicit input without setting any inferred flags (T024)', () => {
    const out = applyInferenceDefaults({
      type: 'constraint',
      summary: 'must support Safari 15',
      affects: ['frontend'],
      text: 'longer detail',
    });
    expect(out.inferred_type).toBe(false);
    expect(out.inferred_summary).toBe(false);
    expect(out.type).toBe('constraint');
    expect(out.summary).toBe('must support Safari 15');
    expect(out.affects).toEqual(['frontend']);
  });

  it('handles empty summary string the same as omitted (FR-006 edge)', () => {
    const out = applyInferenceDefaults({
      summary: '',
      text: 'long detail',
    });
    // Empty-string summary is treated as "not provided" — derive from text.
    expect(out.summary).toBe('long detail');
    expect(out.inferred_summary).toBe(true);
  });
});
