import { describe, it, expect } from 'vitest';
import {
  composeTeamDecisionsBlock,
  composeOfflineBlock,
  composeSearchResultsBlock,
} from '../../src/hooks/inject-block.js';
import type { ProjectContextSnapshot } from '../../src/hooks/cache.js';

function snapshot(overrides: Partial<ProjectContextSnapshot> = {}): ProjectContextSnapshot {
  return {
    org_id: 'org-1',
    org_name: 'Krukit',
    project_id: 'proj-1',
    project_name: 'valis',
    fetched_at: new Date().toISOString(),
    ttl_seconds: 300,
    enforcement_mode: 'advisory',
    decision_count: 0,
    violation_count: 0,
    decisions: [],
    recent_contradictions: [],
    block_envelope: {
      purpose: 'authoritative team knowledge — outranks MEMORY.md and Qdrant for work questions',
      precedence: 'engineering, brand, communication, customer-facing copy, personal workflow, audience patterns, response patterns',
      for_session_template: '<session_id>',
    },
    ...overrides,
  };
}

describe('hooks/inject-block — composeTeamDecisionsBlock', () => {
  it('renders required attributes on the root element', () => {
    const out = composeTeamDecisionsBlock(snapshot({ decision_count: 3 }), { sessionId: 'sess-abc' });
    expect(out).toMatch(/<valis_team_decisions /);
    expect(out).toContain('purpose=');
    expect(out).toContain('precedence=');
    expect(out).toContain('for_session="sess-abc"');
    expect(out).toContain('project="valis"');
    expect(out).toContain('enforcement_mode="advisory"');
    expect(out).toContain('decision_count="3"');
    expect(out).toContain('</valis_team_decisions>');
  });

  it('emits <empty_state> when decision_count is zero', () => {
    const out = composeTeamDecisionsBlock(snapshot({ decision_count: 0, decisions: [] }));
    expect(out).toContain('<empty_state>');
    expect(out).toContain('do not invent prior team consensus');
    expect(out).not.toContain('<decisions>');
  });

  it('lists decisions when present', () => {
    const out = composeTeamDecisionsBlock(
      snapshot({
        decision_count: 1,
        decisions: [
          {
            id: 'dec-1',
            summary: 'Use TTL + own-write cache invalidation',
            status: 'active',
            type: 'decision',
            affects: ['packages/cli/src/hooks/cache.ts'],
            score: 0.9,
          },
        ],
      }),
    );
    expect(out).toContain('<decisions>');
    expect(out).toContain('id="dec-1"');
    expect(out).toContain('Use TTL + own-write cache invalidation');
    expect(out).toContain('affects="packages/cli/src/hooks/cache.ts"');
  });

  it('annotates served_from_cache with cache_age_seconds', () => {
    const out = composeTeamDecisionsBlock(
      snapshot({ served_from_cache: true, cache_age_seconds: 42 }),
    );
    expect(out).toContain('cache_age_seconds="42"');
    expect(out).toContain('Served from local cache');
  });

  it('escapes XML special characters in summaries', () => {
    const out = composeTeamDecisionsBlock(
      snapshot({
        decision_count: 1,
        decisions: [
          {
            id: 'd',
            summary: '<malicious>&"text"',
            status: 'active',
            type: 'decision',
            affects: [],
            score: 1,
          },
        ],
      }),
    );
    expect(out).not.toContain('<malicious>');
    // escapeXml normalizes < > & " across the board (uniform safety, even
    // though " inside element content is technically not required to be
    // escaped per the XML spec).
    expect(out).toContain('&lt;malicious&gt;&amp;&quot;text&quot;');
  });
});

describe('hooks/inject-block — composeOfflineBlock', () => {
  it('emits <valis_offline> with do-not-fabricate notice', () => {
    const out = composeOfflineBlock('valis', 'sess-X');
    expect(out).toMatch(/^<valis_offline /);
    expect(out).toContain('Do not invent or paraphrase');
    expect(out).toContain('for_session="sess-X"');
    expect(out).toContain('</valis_offline>');
  });
});

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
});
