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

import { readFile } from 'node:fs/promises';
import { resolveProjectMarker } from './project-resolver.js';
import { augment } from './augment.js';
import { record } from './telemetry.js';
import { configPath } from './paths.js';

const DEFAULT_API_BASE = 'https://valis.krukit.co';

interface GlobalConfig {
  org_id?: string;
  member_api_key?: string;
  api_key?: string;
  api_base_url?: string;
  per_prompt_augmentation?: boolean;
  per_prompt_threshold?: number;
  per_prompt_budget?: number;
}

async function loadGlobalConfig(): Promise<GlobalConfig | null> {
  try {
    const data = await readFile(configPath(), 'utf-8');
    return JSON.parse(data) as GlobalConfig;
  } catch {
    return null;
  }
}

interface ProjectConfig {
  project_id?: string;
  per_prompt_augmentation?: boolean;
  per_prompt_threshold?: number;
  per_prompt_budget?: number;
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

  const marker = await resolveProjectMarker();
  if (!marker || !marker.projectId) return;

  const cfg = await loadGlobalConfig();
  if (!cfg || !cfg.org_id) return;

  // FR-037: more-restrictive-wins. Project disable cannot be overridden by user.
  const projectCfg = (marker.config ?? {}) as ProjectConfig;
  const userOpt = cfg.per_prompt_augmentation;
  const projectOpt = projectCfg.per_prompt_augmentation;
  if (projectOpt === false || userOpt === false) {
    return; // Branch D
  }

  const apiKey = cfg.member_api_key ?? cfg.api_key ?? '';
  const apiBaseUrl = cfg.api_base_url ?? DEFAULT_API_BASE;
  if (!apiKey) return;

  const threshold =
    typeof projectCfg.per_prompt_threshold === 'number'
      ? projectCfg.per_prompt_threshold
      : typeof cfg.per_prompt_threshold === 'number'
        ? cfg.per_prompt_threshold
        : undefined;
  const budgetTokens =
    typeof projectCfg.per_prompt_budget === 'number'
      ? projectCfg.per_prompt_budget
      : typeof cfg.per_prompt_budget === 'number'
        ? cfg.per_prompt_budget
        : undefined;

  void record('prompt_search_served', {
    org_id: cfg.org_id,
    project_id: marker.projectId,
  });

  const outcome = await augment(prompt, {
    apiBaseUrl,
    apiKey,
    projectId: marker.projectId,
    threshold,
    budgetTokens,
  });

  switch (outcome.reason) {
    case 'served':
      emitContext(outcome.block!);
      void record('prompt_search_hit', {
        org_id: cfg.org_id,
        project_id: marker.projectId,
        latency_ms: Date.now() - startedAt,
      });
      return;
    case 'no_results':
    case 'all_below_threshold':
      void record('prompt_search_miss_threshold', {
        org_id: cfg.org_id,
        project_id: marker.projectId,
        latency_ms: Date.now() - startedAt,
        metadata: { raw_count: outcome.rawCount },
      });
      return;
    case 'all_over_budget':
      void record('prompt_search_miss_budget', {
        org_id: cfg.org_id,
        project_id: marker.projectId,
        latency_ms: Date.now() - startedAt,
        metadata: {
          above_threshold_count: outcome.aboveThresholdCount,
        },
      });
      return;
    case 'timeout':
      void record('prompt_search_timeout', {
        org_id: cfg.org_id,
        project_id: marker.projectId,
        latency_ms: Date.now() - startedAt,
      });
      return;
    case 'fetch_failed':
      void record('hook_failure', {
        org_id: cfg.org_id,
        project_id: marker.projectId,
        latency_ms: Date.now() - startedAt,
        error_message: 'augment fetch failed',
      });
      return;
  }
}
