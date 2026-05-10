/**
 * UserPromptSubmit hook handler — Phase A US2.
 *
 * Branches per contracts/hook-protocol.md:
 *   A — search succeeded with ≥1 above-threshold result that fits budget → inject block.
 *   B — 0 results above threshold → empty stdout (silent skip), log `prompt_search_miss_threshold`.
 *   C — above-threshold but over budget → empty stdout, log `prompt_search_miss_budget`.
 *   D — augmentation disabled (project or user opt-out) → empty stdout, no log.
 *   E — timeout → empty stdout, log `prompt_search_timeout`.
 *
 * Constitution III: any failure → empty stdout, exit 0.
 */

import { loadHookMarker, loadHookGlobalConfig } from './context.js';
import { augment } from './augment.js';
import { record } from './telemetry.js';

/** Hook-specific overrides we look for in `.valis.json` and `~/.valis/config.json`. */
interface PerPromptOverrides {
  per_prompt_augmentation?: boolean;
  per_prompt_threshold?: number;
  per_prompt_budget?: number;
}

function readOverrides(raw: Record<string, unknown>): PerPromptOverrides {
  return {
    per_prompt_augmentation:
      typeof raw.per_prompt_augmentation === 'boolean' ? raw.per_prompt_augmentation : undefined,
    per_prompt_threshold:
      typeof raw.per_prompt_threshold === 'number' ? raw.per_prompt_threshold : undefined,
    per_prompt_budget:
      typeof raw.per_prompt_budget === 'number' ? raw.per_prompt_budget : undefined,
  };
}

function emitContext(additionalContext: string): void {
  const payload = {
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext,
    },
  };
  process.stdout.write(JSON.stringify(payload));
}

export async function hookUserPromptSubmitCommand(): Promise<void> {
  const startedAt = Date.now();
  const prompt = process.env.CLAUDE_USER_PROMPT ?? '';
  if (!prompt) return;

  const marker = await loadHookMarker();
  if (!marker) return;

  const cfg = await loadHookGlobalConfig();
  if (!cfg) return;

  // FR-037: more-restrictive-wins. Project disable cannot be overridden by user.
  const projectOverrides = readOverrides(marker.raw);
  const userOverrides = readOverrides(cfg.raw);
  if (projectOverrides.per_prompt_augmentation === false || userOverrides.per_prompt_augmentation === false) {
    return; // Branch D
  }

  if (!cfg.apiKey) return;

  const threshold = projectOverrides.per_prompt_threshold ?? userOverrides.per_prompt_threshold;
  const budgetTokens = projectOverrides.per_prompt_budget ?? userOverrides.per_prompt_budget;

  void record('prompt_search_served', {
    org_id: cfg.orgId,
    project_id: marker.projectId,
  });

  const outcome = await augment(prompt, {
    apiBaseUrl: cfg.apiBaseUrl,
    apiKey: cfg.apiKey,
    projectId: marker.projectId,
    threshold,
    budgetTokens,
  });

  switch (outcome.reason) {
    case 'served':
      emitContext(outcome.block!);
      void record('prompt_search_hit', {
        org_id: cfg.orgId,
        project_id: marker.projectId,
        latency_ms: Date.now() - startedAt,
      });
      return;
    case 'no_results':
    case 'all_below_threshold':
      void record('prompt_search_miss_threshold', {
        org_id: cfg.orgId,
        project_id: marker.projectId,
        latency_ms: Date.now() - startedAt,
        metadata: { raw_count: outcome.rawCount },
      });
      return;
    case 'all_over_budget':
      void record('prompt_search_miss_budget', {
        org_id: cfg.orgId,
        project_id: marker.projectId,
        latency_ms: Date.now() - startedAt,
        metadata: {
          above_threshold_count: outcome.aboveThresholdCount,
        },
      });
      return;
    case 'timeout':
      void record('prompt_search_timeout', {
        org_id: cfg.orgId,
        project_id: marker.projectId,
        latency_ms: Date.now() - startedAt,
      });
      return;
    case 'fetch_failed':
      void record('hook_failure', {
        org_id: cfg.orgId,
        project_id: marker.projectId,
        latency_ms: Date.now() - startedAt,
        error_message: 'augment fetch failed',
      });
      return;
  }
}
