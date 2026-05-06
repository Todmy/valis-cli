/**
 * Labeled-block serializer for SessionStart and UserPromptSubmit hooks.
 *
 * Per FR-002 + research.md R-12 (Letta/MemGPT pattern). Output is a literal
 * XML-shaped block the agent reads as authoritative team knowledge.
 *
 * Two serializers:
 *  - composeTeamDecisionsBlock — SessionStart payload (full snapshot or empty/offline)
 *  - composeSearchResultsBlock — UserPromptSubmit per-prompt augmentation
 */

import type {
  ProjectContextSnapshot,
  DecisionSummary,
  ContradictionSummary,
} from './cache.js';
import { fillSlot, estimateTokens } from './budget.js';
import {
  PURPOSE_STRING,
  PRECEDENCE_STRING,
} from './precedence.js';

const DEFAULT_DECISIONS_BUDGET_TOKENS = 1500;
const DEFAULT_SEARCH_BUDGET_TOKENS = 800;

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function serializeDecision(d: DecisionSummary): string {
  const affects = d.affects.length > 0 ? ` affects="${escapeXml(d.affects.join(', '))}"` : '';
  return `  <decision id="${escapeXml(d.id)}" type="${escapeXml(d.type)}" status="${escapeXml(d.status)}"${affects}>${escapeXml(d.summary)}</decision>`;
}

function serializeContradiction(c: ContradictionSummary): string {
  return `  <contradiction id="${escapeXml(c.id)}" between="${escapeXml(c.decision_a_id)}|${escapeXml(c.decision_b_id)}">${escapeXml(c.summary)}</contradiction>`;
}

export interface InjectOptions {
  /** Optional override for the per-decision budget cap. */
  decisionsBudgetTokens?: number;
  /** Substituted into block_envelope.for_session_template. */
  sessionId?: string;
}

/**
 * Compose the SessionStart `<valis_team_decisions>` block.
 *
 * Branches per contracts/hook-protocol.md:
 *  - Branch A (fresh): straightforward render with decisions list.
 *  - Branch B (stale cache): include cache_age_seconds attribute.
 *  - Branch D (zero decisions): emit <empty_state> child instead of decision list.
 *
 * Branch C (offline + no cache) uses composeOfflineBlock instead.
 */
export function composeTeamDecisionsBlock(
  snapshot: ProjectContextSnapshot,
  opts: InjectOptions = {},
): string {
  const env = snapshot.block_envelope;
  const sessionId = opts.sessionId ?? env.for_session_template;
  const cacheAgeAttr =
    snapshot.served_from_cache && snapshot.cache_age_seconds !== undefined
      ? ` cache_age_seconds="${snapshot.cache_age_seconds}"`
      : '';

  const head = `<valis_team_decisions purpose="${escapeXml(env.purpose)}" precedence="${escapeXml(env.precedence)}" for_session="${escapeXml(sessionId)}" project="${escapeXml(snapshot.project_name)}" enforcement_mode="${escapeXml(snapshot.enforcement_mode)}" decision_count="${snapshot.decision_count}" violation_count="${snapshot.violation_count}"${cacheAgeAttr}>`;

  const lines: string[] = [head];

  if (snapshot.served_from_cache && snapshot.cache_age_seconds !== undefined) {
    lines.push(
      `  <note>Served from local cache (age: ${snapshot.cache_age_seconds}s) — backend was unreachable. Treat as best-known team state.</note>`,
    );
  }

  if (snapshot.decision_count === 0 || snapshot.decisions.length === 0) {
    lines.push(
      '  <empty_state>This project has zero captured team decisions. Propose calling valis_store as decisions emerge in conversation; do not invent prior team consensus.</empty_state>',
    );
  } else {
    const items = snapshot.decisions.map((d) => ({ text: serializeDecision(d), decision: d }));
    const fill = fillSlot(items, opts.decisionsBudgetTokens ?? DEFAULT_DECISIONS_BUDGET_TOKENS);
    lines.push('  <decisions>');
    for (const item of fill.selected) lines.push(item.text);
    if (fill.droppedCount > 0) {
      lines.push(`  </decisions>`);
      lines.push(
        `  <note>Showing top ${fill.selected.length} of ${snapshot.decision_count} active decisions (token-budget cap). Use valis_search for the rest.</note>`,
      );
    } else {
      lines.push('  </decisions>');
    }
  }

  if (snapshot.recent_contradictions.length > 0) {
    lines.push('  <contradictions>');
    for (const c of snapshot.recent_contradictions) lines.push(serializeContradiction(c));
    lines.push('  </contradictions>');
  }

  lines.push('</valis_team_decisions>');
  return lines.join('\n');
}

/**
 * Branch C: backend unreachable + no cache. Inject explicit "do not fabricate" notice.
 */
export function composeOfflineBlock(projectName: string | undefined, sessionId: string): string {
  const proj = projectName ? ` project="${escapeXml(projectName)}"` : '';
  return [
    `<valis_offline purpose="${escapeXml(PURPOSE_STRING)}" precedence="${escapeXml(PRECEDENCE_STRING)}" for_session="${escapeXml(sessionId)}"${proj}>`,
    '  <note>Valis backend is unreachable and no recent cache is available for this project. Do not invent or paraphrase prior team decisions; ask the engineer instead.</note>',
    '</valis_offline>',
  ].join('\n');
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
