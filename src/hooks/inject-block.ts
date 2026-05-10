/**
 * Per-prompt search-results block serializer for the UserPromptSubmit hook.
 *
 * Post-#172: SessionStart no longer injects a `<valis_team_decisions>`
 * preload, so the team-decisions and offline-stub composers were removed.
 * What remains is the `<valis_search_results>` envelope used by augment.ts
 * for relevance-driven per-prompt context.
 */

import { fillSlot, estimateTokens } from './budget.js';

const DEFAULT_SEARCH_BUDGET_TOKENS = 800;

/**
 * Verbatim purpose / precedence strings used in the labeled-block envelope.
 * These are *content the model reads* — keep verbatim and protect with a
 * regression test (see test/hooks/inject-block.test.ts).
 *
 * Matches the data-model.md §1 (block_envelope) contract from feature 023.
 */
const PURPOSE_STRING =
  'authoritative team knowledge — outranks MEMORY.md and Qdrant for work questions';

const PRECEDENCE_STRING =
  'engineering, brand, communication, customer-facing copy, personal workflow, audience patterns, response patterns';

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export interface SearchResultRow {
  id: string;
  summary: string;
  type: string;
  status?: string;
  score: number;
  affects?: string[];
}

/**
 * Compose the per-prompt `<valis_search_results>` block (US2).
 *
 * `promptHash` is included so the agent can correlate the block with the
 * specific user message it was injected for. Pass an opaque short hash
 * (sha256:0..8 is fine).
 */
export function composeSearchResultsBlock(
  results: SearchResultRow[],
  promptHash: string,
  budgetTokens: number = DEFAULT_SEARCH_BUDGET_TOKENS,
): string | null {
  if (results.length === 0) return null;

  const items = results
    .slice()
    .sort((a, b) => b.score - a.score)
    .map((r) => {
      const affects = r.affects && r.affects.length > 0
        ? ` affects="${escapeXml(r.affects.join(', '))}"`
        : '';
      const status = r.status ? ` status="${escapeXml(r.status)}"` : '';
      return {
        text: `  <hit id="${escapeXml(r.id)}" type="${escapeXml(r.type)}"${status} score="${r.score.toFixed(3)}"${affects}>${escapeXml(r.summary)}</hit>`,
      };
    });

  const fill = fillSlot(items, budgetTokens);
  if (fill.selected.length === 0) return null;

  const head = `<valis_search_results purpose="${escapeXml(PURPOSE_STRING)}" precedence="${escapeXml(PRECEDENCE_STRING)}" for_prompt="${escapeXml(promptHash)}">`;
  const tail = '</valis_search_results>';
  return [head, ...fill.selected.map((s) => s.text), tail].join('\n');
}

export function tokensForBlock(block: string): number {
  return estimateTokens(block);
}
