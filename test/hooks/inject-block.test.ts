import { describe, it, expect } from 'vitest';
import {
  composeActiveProjectBlock,
  composeSearchResultsBlock,
  composeUpdateAvailableBlock,
} from '../../src/hooks/inject-block.js';

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

describe('hooks/inject-block — composeActiveProjectBlock (BUG #176)', () => {
  it('emits a <valis_active_project> envelope carrying project_id and project_name', () => {
    const out = composeActiveProjectBlock(
      '22222222-2222-2222-2222-222222222222',
      'mojob',
    );
    expect(out).toContain('<valis_active_project');
    expect(out).toContain('project_id="22222222-2222-2222-2222-222222222222"');
    expect(out).toContain('project_name="mojob"');
    expect(out).toContain('</valis_active_project>');
  });

  it('instructs the agent to pass project_id explicitly to valis_* MCP calls', () => {
    const out = composeActiveProjectBlock('id-1', 'demo');
    expect(out).toMatch(/valis_\*|valis_store/);
    expect(out).toMatch(/pass project_id/i);
    expect(out).toMatch(/explicit|automatically/i);
  });

  it('escapes XML special characters in project_name', () => {
    const out = composeActiveProjectBlock('id-1', 'name & "<weird>"');
    expect(out).toContain('name &amp; &quot;&lt;weird&gt;&quot;');
  });

  it('is compact — under ~150 tokens — so it never crowds search/reminder budgets', () => {
    const out = composeActiveProjectBlock(
      '22222222-2222-2222-2222-222222222222',
      'a-reasonably-long-project-name-for-the-test',
    );
    // 4 chars per token estimator (matches budget.ts) — block stays well
    // under 150 tokens for any realistic project_name length.
    expect(Math.ceil(out.length / 4)).toBeLessThan(150);
  });
});

describe('hooks/inject-block — composeUpdateAvailableBlock (BUG #178)', () => {
  it('emits a version-manager-aware block for reason="managed"', () => {
    const out = composeUpdateAvailableBlock('0.5.6', '0.5.5', 'managed');
    expect(out).toContain('<valis_update_available');
    expect(out).toContain('target_version="0.5.6"');
    expect(out).toContain('current_version="0.5.5"');
    expect(out).toContain('reason="managed"');
    expect(out).toMatch(/nvm|volta|asdf|brew|version manager/i);
    expect(out).toContain('npm i -g valis-cli@latest');
    expect(out).toContain('</valis_update_available>');
  });

  it('emits an opt-out-aware block for reason="opt_out"', () => {
    const out = composeUpdateAvailableBlock('0.5.6', '0.5.5', 'opt_out');
    expect(out).toContain('reason="opt_out"');
    expect(out).toContain('VALIS_DISABLE_AUTOUPDATER');
    expect(out).toContain('npm i -g valis-cli@latest');
  });

  it('reminds the agent to advise a session restart so the new binary takes effect', () => {
    const out = composeUpdateAvailableBlock('0.5.6', '0.5.5', 'managed');
    expect(out).toMatch(/restart Claude Code|session-start|new version takes effect/i);
  });

  it('is compact — under ~200 tokens — so it never crowds search budget', () => {
    const out = composeUpdateAvailableBlock('0.5.6', '0.5.5', 'managed');
    expect(Math.ceil(out.length / 4)).toBeLessThan(200);
  });
});
