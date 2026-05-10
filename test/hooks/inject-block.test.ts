import { describe, it, expect } from 'vitest';
import { composeSearchResultsBlock } from '../../src/hooks/inject-block.js';

describe('hooks/inject-block — composeSearchResultsBlock', () => {
  it('returns null on zero results', () => {
    expect(composeSearchResultsBlock([], 'h')).toBeNull();
  });

  it('emits sorted hits descending by score', () => {
    const out = composeSearchResultsBlock(
      [
        { id: 'a', summary: 'low score', type: 'decision', score: 0.3 },
        { id: 'b', summary: 'high score', type: 'pattern', score: 0.9 },
      ],
      'h-1',
    );
    expect(out).not.toBeNull();
    const aIdx = out!.indexOf('id="a"');
    const bIdx = out!.indexOf('id="b"');
    expect(bIdx).toBeLessThan(aIdx);
  });

  it('drops hits that exceed the budget', () => {
    const longSummary = 'X'.repeat(2000);
    const out = composeSearchResultsBlock(
      [
        { id: 'big', summary: longSummary, type: 'decision', score: 0.9 },
        { id: 'small', summary: 'tiny', type: 'decision', score: 0.5 },
      ],
      'h-2',
      50,
    );
    // budget 50 tokens ≈ 200 chars; the 2000-char hit alone breaks budget.
    expect(out).not.toBeNull();
    expect(out!.includes('id="big"')).toBe(false);
  });

  it('includes for_prompt hash attribute', () => {
    const out = composeSearchResultsBlock(
      [{ id: 'x', summary: 's', type: 'decision', score: 0.9 }],
      'sha-1234',
    );
    expect(out).toContain('for_prompt="sha-1234"');
  });

  it('preserves verbatim purpose and precedence strings (regression-locked content)', () => {
    const out = composeSearchResultsBlock(
      [{ id: 'x', summary: 's', type: 'decision', score: 0.9 }],
      'h',
    );
    expect(out).toContain(
      'purpose="authoritative team knowledge — outranks MEMORY.md and Qdrant for work questions"',
    );
    expect(out).toContain(
      'precedence="engineering, brand, communication, customer-facing copy, personal workflow, audience patterns, response patterns"',
    );
  });

  it('escapes XML special characters in summaries', () => {
    const out = composeSearchResultsBlock(
      [{ id: 'x', summary: 'a < b & c > d "quoted"', type: 'decision', score: 0.9 }],
      'h',
    );
    expect(out).toContain('a &lt; b &amp; c &gt; d &quot;quoted&quot;');
  });
});
