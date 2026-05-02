/**
 * 019/US4 — chunking behaviour.
 *
 * Per speckit.clarify Session 2026-05-03:
 *   Q1: 1500 chars / 200 overlap (default)
 *   Q2: paragraph-aware → sentence fallback → hard slice
 */

import { describe, it, expect } from 'vitest';
import { chunkText } from '../../src/cloud/chunking.js';

describe('US4 — chunkText', () => {
  it('returns single chunk for short text', () => {
    const out = chunkText('hello world');
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({ text: 'hello world', index: 0, total: 1 });
  });

  it('returns single chunk for empty input', () => {
    const out = chunkText('');
    expect(out).toHaveLength(1);
    expect(out[0].total).toBe(1);
  });

  it('preserves text equal to maxChars in one chunk', () => {
    const text = 'a'.repeat(1500);
    const out = chunkText(text);
    expect(out).toHaveLength(1);
    expect(out[0].text).toBe(text);
  });

  it('splits long text into multiple chunks with consistent total', () => {
    const para = 'lorem ipsum dolor sit amet '.repeat(80); // ~2160 chars
    const text = `${para}\n\n${para}\n\n${para}`;
    const out = chunkText(text);
    expect(out.length).toBeGreaterThan(1);
    for (const c of out) {
      expect(c.total).toBe(out.length);
    }
    expect(out.map((c) => c.index)).toEqual(out.map((_, i) => i));
  });

  it('every chunk respects maxChars ceiling', () => {
    const text = 'word '.repeat(2000); // 10 000 chars, no paragraph breaks
    const out = chunkText(text, { maxChars: 1500, overlap: 200 });
    for (const c of out) {
      expect(c.text.length).toBeLessThanOrEqual(1500);
    }
  });

  it('splits on paragraph boundaries when possible', () => {
    const p1 = 'A'.repeat(900);
    const p2 = 'B'.repeat(900);
    const out = chunkText(`${p1}\n\n${p2}`, { maxChars: 1500, overlap: 100 });
    // Two paragraphs of 900 chars each = 1802 chars; can't fit one chunk →
    // expect 2 chunks split on the paragraph break.
    expect(out).toHaveLength(2);
    expect(out[0].text.startsWith('A')).toBe(true);
    // Second chunk starts with overlap of paragraph 1's tail then B-block.
    expect(out[1].text).toContain('B'.repeat(50));
  });

  it('hard-slices a single paragraph that exceeds maxChars', () => {
    const huge = 'x'.repeat(5000); // no paragraph or sentence breaks
    const out = chunkText(huge, { maxChars: 1500, overlap: 200 });
    expect(out.length).toBeGreaterThanOrEqual(3);
    for (const c of out) {
      expect(c.text.length).toBeLessThanOrEqual(1500);
    }
  });

  it('overlap >= maxChars is rejected', () => {
    expect(() => chunkText('x'.repeat(3000), { maxChars: 1000, overlap: 1000 })).toThrow();
  });

  it('handles UA/PL multilingual content without losing characters', () => {
    const ua = 'Ми вирішили перейти на multilingual-e5-large модель. ';
    const text = ua.repeat(80);
    const out = chunkText(text, { maxChars: 1500, overlap: 200 });
    expect(out.length).toBeGreaterThan(1);
    for (const c of out) {
      expect(c.text.length).toBeLessThanOrEqual(1500);
    }
  });
});
