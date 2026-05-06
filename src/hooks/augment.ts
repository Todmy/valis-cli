/**
 * Always-inject per-prompt augmentation logic — Phase A US2.
 *
 * Per FR-013–FR-017 + research.md R-10. NO keyword/regex heuristic gating;
 * the only filters are:
 *   1. backend relevance score above threshold (default 0.4, configurable)
 *   2. per-prompt token-budget cap (default 800 tokens, configurable)
 *
 * Per FR-015, this module MUST NOT contain trigger lists, language detection,
 * or any keyword regex tables. The regression test enforces this by grepping.
 */

import { createHash } from 'node:crypto';
import {
  composeSearchResultsBlock,
  type SearchResultRow,
} from './inject-block.js';

export interface AugmentOptions {
  apiBaseUrl: string;
  apiKey: string;
  projectId: string;
  /** Default 0.4 per FR-014 / R-10. */
  threshold?: number;
  /** Default 800 tokens per FR-016. */
  budgetTokens?: number;
  /** Hard timeout for the backend search in ms. Default 1500 per FR-016. */
  timeoutMs?: number;
  /** Max number of hits requested from backend. Default 10. */
  fetchLimit?: number;
}

const DEFAULT_THRESHOLD = 0.4;
const DEFAULT_BUDGET_TOKENS = 800;
const DEFAULT_TIMEOUT_MS = 1500;
const DEFAULT_FETCH_LIMIT = 10;

function hashPrompt(prompt: string): string {
  return createHash('sha256').update(prompt).digest('hex').slice(0, 12);
}

interface BackendSearchResponse {
  results: Array<{
    id?: string;
    summary?: string | null;
    detail?: string | null;
    type?: string;
    status?: string;
    score?: number;
    affects?: string[];
  }>;
}

export interface AugmentOutcome {
  block: string | null;
  /** Distinguishes the "below threshold" miss from the "over budget" miss. */
  reason:
    | 'served'
    | 'no_results'
    | 'all_below_threshold'
    | 'all_over_budget'
    | 'timeout'
    | 'fetch_failed';
  /** Diagnostic — number of raw hits the backend returned. */
  rawCount: number;
  /** Diagnostic — number of hits above relevance threshold. */
  aboveThresholdCount: number;
  /** Diagnostic — total ms the backend round-trip took. */
  latencyMs: number;
}

export async function augment(
  prompt: string,
  opts: AugmentOptions,
): Promise<AugmentOutcome> {
  const startedAt = Date.now();
  const threshold = opts.threshold ?? DEFAULT_THRESHOLD;
  const budgetTokens = opts.budgetTokens ?? DEFAULT_BUDGET_TOKENS;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchLimit = opts.fetchLimit ?? DEFAULT_FETCH_LIMIT;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let body: BackendSearchResponse;
  try {
    const res = await fetch(`${opts.apiBaseUrl}/api/search`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${opts.apiKey}`,
      },
      body: JSON.stringify({
        query: prompt,
        project_id: opts.projectId,
        limit: fetchLimit,
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) {
      return {
        block: null,
        reason: 'fetch_failed',
        rawCount: 0,
        aboveThresholdCount: 0,
        latencyMs: Date.now() - startedAt,
      };
    }
    body = (await res.json()) as BackendSearchResponse;
  } catch (err) {
    clearTimeout(timer);
    const aborted = (err as { name?: string }).name === 'AbortError';
    return {
      block: null,
      reason: aborted ? 'timeout' : 'fetch_failed',
      rawCount: 0,
      aboveThresholdCount: 0,
      latencyMs: Date.now() - startedAt,
    };
  }

  const raw = Array.isArray(body.results) ? body.results : [];
  if (raw.length === 0) {
    return {
      block: null,
      reason: 'no_results',
      rawCount: 0,
      aboveThresholdCount: 0,
      latencyMs: Date.now() - startedAt,
    };
  }

  const rows: SearchResultRow[] = raw
    .map((r) => ({
      id: r.id ?? '',
      summary: (r.summary ?? r.detail ?? '').slice(0, 200),
      type: r.type ?? 'decision',
      status: r.status,
      score: typeof r.score === 'number' ? r.score : 0,
      affects: r.affects,
    }))
    .filter((r) => r.id && r.score >= threshold);

  if (rows.length === 0) {
    return {
      block: null,
      reason: 'all_below_threshold',
      rawCount: raw.length,
      aboveThresholdCount: 0,
      latencyMs: Date.now() - startedAt,
    };
  }

  const promptHash = hashPrompt(prompt);
  const block = composeSearchResultsBlock(rows, promptHash, budgetTokens);
  if (!block) {
    return {
      block: null,
      reason: 'all_over_budget',
      rawCount: raw.length,
      aboveThresholdCount: rows.length,
      latencyMs: Date.now() - startedAt,
    };
  }

  return {
    block,
    reason: 'served',
    rawCount: raw.length,
    aboveThresholdCount: rows.length,
    latencyMs: Date.now() - startedAt,
  };
}
