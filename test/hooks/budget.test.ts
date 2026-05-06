import { describe, it, expect } from 'vitest';
import { estimateTokens, fillSlot } from '../../src/hooks/budget.js';

describe('hooks/budget — estimateTokens (4-chars-per-token)', () => {
  it('returns 0 for empty string', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('rounds up partial tokens (ceil)', () => {
    expect(estimateTokens('ab')).toBe(1);
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2);
  });

  it('English: roughly 1 token per 4 chars', () => {
    const text = 'The quick brown fox jumps over the lazy dog'; // 43 chars
    expect(estimateTokens(text)).toBe(11); // ceil(43/4) = 11
  });

  it('Cyrillic over-counts (conservative — strings carry as code units)', () => {
    // "Привіт світ" (Ukrainian) — 11 chars in JS string-length terms
    const text = 'Привіт світ';
    expect(estimateTokens(text)).toBe(Math.ceil(text.length / 4));
    // The point is that we never *under*-count for Cyrillic.
    expect(estimateTokens(text)).toBeGreaterThanOrEqual(text.length / 4);
  });

  it('Polish characters count via code-unit length', () => {
    const text = 'żółć dziękuję';
    expect(estimateTokens(text)).toBe(Math.ceil(text.length / 4));
  });
});

describe('hooks/budget — fillSlot', () => {
  const items = (texts: string[]) => texts.map((t) => ({ text: t }));

  it('returns all items when budget is large', () => {
    const r = fillSlot(items(['a'.repeat(8), 'b'.repeat(8)]), 1000);
    expect(r.selected.length).toBe(2);
    expect(r.droppedCount).toBe(0);
  });

  it('drops the first over-budget item, never truncates mid-item', () => {
    // Each item ~16 chars → ~4 tokens; budget 5 tokens fits 1 item.
    const r = fillSlot(items(['x'.repeat(16), 'y'.repeat(16), 'z'.repeat(16)]), 5);
    expect(r.selected.length).toBe(1);
    // Items selected are kept whole.
    expect(r.selected[0].text).toBe('x'.repeat(16));
    expect(r.droppedCount).toBe(2);
  });

  it('respects maxItems even when budget allows more', () => {
    const r = fillSlot(items(['a', 'b', 'c', 'd']), 1000, 2);
    expect(r.selected.length).toBe(2);
    expect(r.droppedCount).toBe(2);
  });

  it('selectedTokens equals sum of estimateTokens for selected items', () => {
    const r = fillSlot(items(['ab', 'cd', 'ef']), 100);
    expect(r.selectedTokens).toBe(3); // 3 × ceil(2/4)=1
  });

  it('returns empty selection when first item exceeds budget', () => {
    const r = fillSlot(items(['a'.repeat(40)]), 5);
    expect(r.selected.length).toBe(0);
    expect(r.droppedCount).toBe(1);
  });
});
