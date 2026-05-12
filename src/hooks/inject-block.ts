/**
 * Per-prompt search-results block serializer for the UserPromptSubmit hook.
 *
 * Post-#172: SessionStart no longer injects a `<valis_team_decisions>`
 * preload, so the team-decisions and offline-stub composers were removed.
 * What remains is the `<valis_search_results>` envelope used by augment.ts
 * for relevance-driven per-prompt context.
 */

import { fillSlot, estimateTokens } from './budget.js';
import type { ChannelEvent } from '../channel/push.js';

const DEFAULT_SEARCH_BUDGET_TOKENS = 800;

/**
 * Fixed reservation for the capture-reminder block. Outside the per-prompt
 * search budget — the reminder must always fit (it's an instruction, not
 * reference material). Defensive ceiling: if `buildCaptureReminder()`
 * content grows past this, the composer throws.
 */
export const CAPTURE_REMINDER_BUDGET_TOKENS = 200;

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

/**
 * Compose a `<channel source="..." event="..." attrs...>content</channel>`
 * envelope around a ChannelEvent. Used by the user-prompt-submit hook to
 * inject a deterministic capture reminder once per session.
 *
 * CLAUDE.md "Channel reminders" rule binds the receiver behavior: when an
 * agent reads this envelope, it should review recent work and store any
 * decisions via valis_store.
 *
 * Throws if the rendered block exceeds CAPTURE_REMINDER_BUDGET_TOKENS — a
 * defensive ceiling against runaway content growth in buildCaptureReminder().
 */
export function composeCaptureReminderBlock(event: ChannelEvent): string {
  const attrs = [
    `source="${escapeXml(event.source)}"`,
    `event="${escapeXml(event.event)}"`,
    ...Object.entries(event.meta)
      // The `event` key duplicates the top-level attribute; skip it.
      .filter(([k]) => k !== 'event' && k !== 'source')
      .map(([k, v]) => `${escapeXml(k)}="${escapeXml(String(v))}"`),
  ].join(' ');

  const block = [
    `<channel ${attrs}>`,
    escapeXml(event.content),
    `</channel>`,
  ].join('\n');

  if (estimateTokens(block) > CAPTURE_REMINDER_BUDGET_TOKENS) {
    throw new Error(
      `capture-reminder block exceeds budget (${CAPTURE_REMINDER_BUDGET_TOKENS} tokens)`,
    );
  }
  return block;
}
