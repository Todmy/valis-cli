/**
 * T069 — SC-002 + SC-008 measurement harness (post-#172).
 *
 * Run on every `pnpm test` since 2026-05-18. The original `VALIS_RUN_MEASUREMENT=1`
 * gate was set up anticipating expensive live-agent dispatch runs; the
 * current implementation is pure structural (loads corpus JSON, runs
 * `composeSearchResultsBlock`, asserts structural invariants). No backend
 * IO, no LLM cost, ~10 ms total. The future live-agent loop will land as
 * a separate, explicitly-gated harness when wired.
 *
 * This harness measures two success criteria from spec.md:
 *
 *   SC-002 — citation rate ≥ 90 %: across a curated multi-domain test
 *            corpus, what fraction of agent answers cite the expected
 *            Valis decision in their first turn?
 *
 *   SC-008 — Valis-preference rate ≥ 95 %: across a Memory.md-vs-Valis
 *            conflict corpus, what fraction of agent answers pick the
 *            Valis-side answer when the two sources disagree?
 *
 * Architecture note (#172): the SessionStart hook no longer composes a
 * `<valis_team_decisions>` block locally — the agent fetches team
 * decisions on demand via the `valis_context` MCP tool, and the per-prompt
 * `<valis_search_results>` block (composed by `composeSearchResultsBlock`)
 * is now the only client-side envelope that carries the precedence string.
 *
 * What this harness measures deterministically:
 *
 *   1. Corpora are well-formed and meet domain / size floors (always-run
 *      sanity tests below).
 *   2. SC-008 structural signal: for each conflict, the per-prompt search
 *      block — the actual envelope the agent sees mid-session post-#172 —
 *      carries the canonical precedence string AND the expected Valis
 *      decision_id. This is a *structural lower bound*; agent-preference
 *      behavior is downstream.
 *   3. SC-002 citation rate requires a live agent loop (Claude Code or
 *      Anthropic SDK) — left as a documented placeholder; a future
 *      backend-integration harness will dispatch each question through
 *      `valis_context` against a seeded fixture and check top-K hits.
 *
 * The full SC-002 / SC-008 measurement requires the live agent loop and
 * is documented in measurement-corpora-<date>.md alongside this harness;
 * results land in release-validation-<date>.md (T061).
 */

import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  composeSearchResultsBlock,
  type SearchResultRow,
} from '../../src/hooks/inject-block.js';

const CORPORA_DIR = join(__dirname, 'corpora');

/** Canonical precedence string — single source of truth lives in inject-block.ts. */
const CANONICAL_PRECEDENCE =
  'engineering, brand, communication, customer-facing copy, personal workflow, audience patterns, response patterns';

interface SC002Question {
  id: string;
  domain: 'engineering' | 'brand' | 'communication' | 'personal_workflow';
  question: string;
  expected_decision_id: string;
  notes?: string;
}

interface SC008Conflict {
  id: string;
  topic: string;
  memory_md_position: string;
  valis_position: string;
  expected_valis_decision_id: string;
  notes?: string;
}

async function loadJson<T>(file: string): Promise<T[]> {
  const raw = await readFile(join(CORPORA_DIR, file), 'utf-8');
  const parsed = JSON.parse(raw);
  return parsed.questions ?? parsed.conflicts ?? parsed;
}

function searchRowFor(decisionId: string): SearchResultRow {
  return {
    id: decisionId,
    summary: `Valis decision ${decisionId}`,
    type: 'decision',
    score: 0.92,
    affects: ['measurement-harness'],
  };
}

describe('SC-002 measurement harness — citation rate ≥ 90 %', () => {
  it('loads the multi-domain corpus and reports a citation rate', async () => {
    const questions = await loadJson<SC002Question>('sc-002-citations.json');
    expect(questions.length).toBeGreaterThanOrEqual(30);

    const domains = new Set(questions.map((q) => q.domain));
    expect(domains.has('engineering')).toBe(true);
    expect(domains.has('brand')).toBe(true);
    expect(domains.has('communication')).toBe(true);
    expect(domains.has('personal_workflow')).toBe(true);

    // To run an actual citation-rate measurement post-#172, dispatch each
    // question through `valis_context` (MCP) against a seeded backend
    // and check whether the expected_decision_id appears in the top-K
    // hits. The pure-data structural check is delegated to the always-run
    // corpora sanity block below.
    console.log(`SC-002 harness ready: ${questions.length} questions across ${domains.size} domains.`);
    console.log('To complete measurement, dispatch each question through `valis_context`');
    console.log('and check whether the expected decision_id is in the top-K MCP response.');
  });
});

describe('SC-008 measurement harness — Valis-preference rate ≥ 95 %', () => {
  it('verifies the per-prompt block carries the precedence signal for every conflict', async () => {
    const conflicts = await loadJson<SC008Conflict>('sc-008-conflicts.json');
    expect(conflicts.length).toBeGreaterThanOrEqual(20);

    // Structural check on the post-#172 client-side envelope: the per-prompt
    // search-results block, which `user-prompt-submit-handler` injects via
    // `composeSearchResultsBlock`, must carry both the canonical precedence
    // string and the expected Valis decision_id for each conflict.
    let withSignal = 0;
    for (const c of conflicts) {
      const block = composeSearchResultsBlock(
        [searchRowFor(c.expected_valis_decision_id)],
        `m-${c.id}`,
      );
      if (!block) continue;
      const hasPrecedence = block.includes(`precedence="${CANONICAL_PRECEDENCE}"`);
      const hasDecisionId = block.includes(`id="${c.expected_valis_decision_id}"`);
      if (hasPrecedence && hasDecisionId) withSignal++;
    }
    const signalRate = withSignal / conflicts.length;
    console.log(`SC-008 structural-signal rate: ${(signalRate * 100).toFixed(1)} % across ${conflicts.length} conflicts.`);
    expect(signalRate).toBe(1);
    console.log('To complete the agent-preference measurement, run each conflict through the');
    console.log('live agent with both MEMORY.md and Valis present, and check which side wins.');
  });
});

// Always-run sanity tests so the harness file itself doesn't bit-rot.
describe('SC-002 + SC-008 corpora sanity', () => {
  it('SC-002 corpus parses and meets the 30-question floor', async () => {
    const questions = await loadJson<SC002Question>('sc-002-citations.json');
    expect(questions.length).toBeGreaterThanOrEqual(30);
    for (const q of questions) {
      expect(q.id).toBeTruthy();
      expect(q.domain).toMatch(/^(engineering|brand|communication|personal_workflow)$/);
      expect(q.expected_decision_id).toBeTruthy();
      expect(q.question.length).toBeGreaterThan(0);
    }
  });

  it('SC-008 corpus parses and meets the 20-conflict floor', async () => {
    const conflicts = await loadJson<SC008Conflict>('sc-008-conflicts.json');
    expect(conflicts.length).toBeGreaterThanOrEqual(20);
    for (const c of conflicts) {
      expect(c.id).toBeTruthy();
      expect(c.memory_md_position).toBeTruthy();
      expect(c.valis_position).toBeTruthy();
      expect(c.expected_valis_decision_id).toBeTruthy();
    }
  });

  it('canonical precedence string is reachable via composeSearchResultsBlock (regression-locked)', () => {
    const block = composeSearchResultsBlock(
      [searchRowFor('decision-canary')],
      'sanity-hash',
    );
    expect(block).not.toBeNull();
    expect(block!).toContain(`precedence="${CANONICAL_PRECEDENCE}"`);
    expect(block!).toContain('id="decision-canary"');
  });
});
