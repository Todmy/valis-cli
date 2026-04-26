/**
 * 019/US2 — `valis_check_diff` MCP tool
 *
 * Thin wrapper around `/api/check`. Lets a developer dry-run the same
 * enforcement check that runs at PR time, against their working-tree diff,
 * inside the IDE session before committing.
 *
 * Per research R-002: we deliberately use an internal `fetch` to /api/check
 * rather than importing the route handler directly. Same Vercel Function
 * instance, sub-millisecond overhead, but keeps the layer boundary clean
 * and guarantees parity with PR-time behaviour (FR-005, SC-002).
 *
 * Per research R-005 + contract `mcp-check-diff.md`: the tool deliberately
 * OMITS `pr_url` from the request metadata so /api/check classifies the
 * audit row as `surface: 'in_session'`.
 */

import { loadConfig } from '../../config/store.js';
import { resolveConfig } from '../../config/project.js';
import { resolveApiUrl, isHostedMode } from '../../cloud/api-url.js';
import type { ServerConfig, ValisConfig } from '../../types.js';

export interface CheckDiffArgs {
  /** Unified-diff text (output of `git diff` or equivalent). */
  diff: string;
  /** Optional explicit project scope. Resolved from session config when absent. */
  project_id?: string;
  /** Optional in-session metadata. `pr_url` is intentionally NOT accepted. */
  metadata?: {
    actor?: string;
    commit_sha?: string;
  };
}

export interface CheckDiffContentBlock {
  type: 'text';
  text: string;
  [key: string]: unknown;
}

export interface CheckDiffResult {
  content: CheckDiffContentBlock[];
  isError?: boolean;
  /** MCP SDK CallToolResult requires an index signature. */
  [key: string]: unknown;
}

interface ApiCheckSuccessBody {
  violations: Array<{
    decision_id: string;
    severity: 'block' | 'warn' | 'info';
    file_path: string;
    line_start?: number;
    line_end?: number;
    rationale?: string;
    decision_summary?: string;
  }>;
  budget_exhausted: boolean;
  decisions_evaluated: number;
  decisions_skipped: number;
  elapsed_ms: number;
  reason?: string;
  audit_failed?: boolean;
}

interface ApiCheckErrorBody {
  error: string;
  message: string;
}

const SOFT_FAIL_OPEN_REASONS = new Set([
  'project_daily_budget_exceeded',
  'diff_too_large',
  'too_many_candidate_decisions',
  'llm_unavailable',
  'qdrant_unavailable',
]);

function textBlock(text: string): CheckDiffContentBlock {
  return { type: 'text' as const, text };
}

function errorResult(text: string): CheckDiffResult {
  return { content: [textBlock(text)], isError: true };
}

function pluralise(n: number, word: string): string {
  return n === 1 ? `${n} ${word}` : `${n} ${word}s`;
}

export async function handleCheckDiff(
  args: CheckDiffArgs,
  configOverride?: ServerConfig,
): Promise<CheckDiffResult> {
  if (typeof args.diff !== 'string' || args.diff.trim().length === 0) {
    return errorResult(
      'Check could not run: malformed_diff — `diff` must be a non-empty unified-diff string.',
    );
  }

  const config = (configOverride ?? (await loadConfig())) as ValisConfig | null;
  if (!config) {
    return errorResult(
      'Check could not run: unauthorized — Valis is not configured. Run `valis init` first.',
    );
  }

  // Resolve project: explicit arg > session config > .valis.json
  const resolved = configOverride ? null : await resolveConfig();
  const projectId =
    args.project_id ?? configOverride?.project_id ?? resolved?.project?.project_id;

  if (!projectId) {
    return errorResult(
      'Check could not run: project_not_found — no project scope. Pass `project_id` or run `valis init` in this directory.',
    );
  }

  const bearer = config.member_api_key || config.api_key;
  if (!bearer) {
    return errorResult('Check could not run: unauthorized — missing auth credentials.');
  }

  const apiBase = resolveApiUrl(config.supabase_url, isHostedMode(config));
  const url = `${apiBase}/api/check`;

  const requestBody: Record<string, unknown> = {
    project_id: projectId,
    diff: args.diff,
  };

  // Per contract: forward only actor + commit_sha. NEVER include pr_url —
  // that's the field /api/check uses to classify a check as PR-time.
  if (args.metadata?.actor || args.metadata?.commit_sha) {
    requestBody.metadata = {
      ...(args.metadata.actor ? { actor: args.metadata.actor } : {}),
      ...(args.metadata.commit_sha ? { commit_sha: args.metadata.commit_sha } : {}),
    };
  }

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${bearer}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody),
    });
  } catch (err) {
    return errorResult(
      `Check could not run: network_unreachable — ${err instanceof Error ? err.message : String(err)}.`,
    );
  }

  let parsed: ApiCheckSuccessBody | ApiCheckErrorBody;
  try {
    parsed = (await response.json()) as ApiCheckSuccessBody | ApiCheckErrorBody;
  } catch {
    return errorResult(
      `Check could not run: internal — response was not valid JSON (HTTP ${response.status}).`,
    );
  }

  // Hard error path: 4xx / 5xx with structured error body.
  if (!response.ok) {
    const errBody = parsed as ApiCheckErrorBody;
    const code = errBody.error ?? `http_${response.status}`;
    const message = errBody.message ?? response.statusText ?? 'Unknown error';
    return errorResult(`Check could not run: ${code} — ${message}.`);
  }

  const body = parsed as ApiCheckSuccessBody;

  // Soft fail-open path: 200 with `reason` field. Surface the reason
  // without isError so the user can keep working.
  if (body.reason && SOFT_FAIL_OPEN_REASONS.has(body.reason)) {
    return {
      content: [
        textBlock(softFailOpenMessage(body.reason)),
      ],
    };
  }

  // No decisions captured for this project → friendly message + zero LLM cost.
  // /api/check signals this with decisions_evaluated === 0 and no soft reason.
  if (body.decisions_evaluated === 0 && body.violations.length === 0) {
    return {
      content: [
        textBlock(
          'This project has no recorded decisions yet — check passes by default. Capture decisions via `valis_store` to start enforcement.',
        ),
      ],
    };
  }

  if (body.violations.length === 0) {
    return {
      content: [
        textBlock(
          `Working tree is clean against your team's recorded decisions. Decisions evaluated: ${body.decisions_evaluated}.`,
        ),
      ],
    };
  }

  // Violations present — emit one summary block + one block per violation +
  // optional footer tip.
  const tally = body.violations.reduce(
    (acc, v) => {
      acc[v.severity] += 1;
      return acc;
    },
    { block: 0, warn: 0, info: 0 } as Record<'block' | 'warn' | 'info', number>,
  );

  const elapsedSeconds = (body.elapsed_ms / 1000).toFixed(1);
  const summary =
    `Found ${pluralise(body.violations.length, 'decision violation')}: ` +
    `${tally.block} block, ${tally.warn} warn, ${tally.info} info.\n` +
    `Decisions evaluated: ${body.decisions_evaluated}. Elapsed: ${elapsedSeconds}s.`;

  const blocks: CheckDiffContentBlock[] = [textBlock(summary)];

  for (const v of body.violations) {
    const range =
      v.line_start !== undefined && v.line_end !== undefined
        ? `${v.line_start}-${v.line_end}`
        : v.line_start !== undefined
          ? String(v.line_start)
          : '';
    const location = range ? `${v.file_path}:${range}` : v.file_path;
    const decisionLabel = v.decision_summary
      ? `Decision: "${v.decision_summary}"`
      : `Decision: ${v.decision_id}`;
    const rationale = v.rationale ? `\n  ${v.rationale}` : '';
    blocks.push(
      textBlock(`${location} — ${v.severity} — ${decisionLabel}${rationale}`),
    );
  }

  if (tally.block > 0) {
    blocks.push(
      textBlock(
        'Fix the block-severity violations before committing, or use the `[valis-ack: <decision_id>]` commit-message marker to acknowledge them explicitly with audit trail.',
      ),
    );
  }

  return { content: blocks };
}

function softFailOpenMessage(reason: string): string {
  switch (reason) {
    case 'project_daily_budget_exceeded':
      return 'Check skipped — project over daily budget (upgrade to Team for unlimited). This is a temporary signal; no violations are recorded.';
    case 'diff_too_large':
      return 'Check skipped — diff is larger than the supported window. Split into smaller commits and re-run.';
    case 'too_many_candidate_decisions':
      return 'Check skipped — too many candidate decisions matched this diff. Narrow the change or contact support.';
    case 'llm_unavailable':
      return 'Check skipped — enforcement engine is temporarily unavailable. Try again in a moment.';
    case 'qdrant_unavailable':
      return 'Check skipped — decision retrieval is temporarily unavailable. Try again in a moment.';
    default:
      return `Check skipped — ${reason}.`;
  }
}
