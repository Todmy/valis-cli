/**
 * UserPromptSubmit hook handler — Phase A US2 + capture-reminder injection.
 *
 * Branches per contracts/hook-protocol.md:
 *   A — search succeeded with ≥1 above-threshold result that fits budget → inject block.
 *   B — 0 results above threshold → no search block, log `prompt_search_miss_threshold`.
 *   C — above-threshold but over budget → no search block, log `prompt_search_miss_budget`.
 *   D — augmentation disabled (project or user opt-out) → no search block, no log.
 *   E — timeout → no search block, log `prompt_search_timeout`.
 *
 * In addition to the search block, a deterministic per-session capture
 * reminder may be appended (see session-marker.ts for the trigger rule).
 * The two pieces are combined into a single `additionalContext` string and
 * emitted once at the end of the handler.
 *
 * Constitution III: any failure → empty stdout, exit 0.
 */

import { findProjectMarker } from '../config/project.js';
import { loadHookGlobalConfig } from './context.js';
import { augment } from './augment.js';
import { record } from './telemetry.js';
import { buildCaptureReminder } from '../channel/push.js';
import { composeCaptureReminderBlock } from './inject-block.js';
import {
  DEFAULT_INTERVAL_TURNS,
  DEFAULT_MIN_TURN,
  freshMarker,
  maybeSchedulePrune,
  readSessionMarker,
  shouldInjectCaptureReminder,
  writeSessionMarker,
  type CaptureReminderConfig,
  type CaptureReminderDecision,
  type SessionMarker,
} from './session-marker.js';

/** Hook-specific overrides we look for in `.valis.json` and `~/.valis/config.json`. */
interface PerPromptOverrides {
  per_prompt_augmentation?: boolean;
  per_prompt_threshold?: number;
  per_prompt_budget?: number;
}

interface CaptureReminderOverrides {
  capture_reminder_enabled?: boolean;
  capture_reminder_min_turn?: number;
  capture_reminder_interval?: number;
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

function readCaptureReminderOverrides(raw: Record<string, unknown>): CaptureReminderOverrides {
  return {
    capture_reminder_enabled:
      typeof raw.capture_reminder_enabled === 'boolean'
        ? raw.capture_reminder_enabled
        : undefined,
    capture_reminder_min_turn:
      typeof raw.capture_reminder_min_turn === 'number'
        ? raw.capture_reminder_min_turn
        : undefined,
    capture_reminder_interval:
      typeof raw.capture_reminder_interval === 'number'
        ? raw.capture_reminder_interval
        : undefined,
  };
}

/**
 * Resolve capture-reminder config with more-restrictive-wins semantics:
 * project disable overrides user enable; project enable can still be
 * disabled by user.
 */
function resolveCaptureReminderConfig(
  projectOverrides: CaptureReminderOverrides,
  userOverrides: CaptureReminderOverrides,
): CaptureReminderConfig {
  const enabled =
    projectOverrides.capture_reminder_enabled !== false &&
    userOverrides.capture_reminder_enabled !== false;
  const minTurn =
    projectOverrides.capture_reminder_min_turn ??
    userOverrides.capture_reminder_min_turn ??
    DEFAULT_MIN_TURN;
  const intervalTurns =
    projectOverrides.capture_reminder_interval ??
    userOverrides.capture_reminder_interval ??
    DEFAULT_INTERVAL_TURNS;
  return { enabled, minTurn, intervalTurns };
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

/**
 * Compute the capture-reminder decision + persist updated marker. Pure work
 * is delegated to `shouldInjectCaptureReminder`; this function is the IO
 * boundary. Returns null when reminder should not be injected (so caller
 * can append nothing to additionalContext).
 */
async function evaluateCaptureReminder(
  prompt: string,
  sessionId: string,
  config: CaptureReminderConfig,
  now: Date,
): Promise<{ block: string | null; decision: CaptureReminderDecision; marker: SessionMarker }> {
  const existing = (await readSessionMarker(sessionId)) ?? freshMarker(sessionId, now);
  const decision = shouldInjectCaptureReminder(existing, prompt, config);

  const updated: SessionMarker = {
    ...existing,
    last_seen_at: now.toISOString(),
    turn_count: decision.newTurnCount,
  };
  if (decision.inject) {
    updated.reminder_count = existing.reminder_count + 1;
    updated.last_reminder_turn = decision.newTurnCount;
    updated.last_reminder_at = now.toISOString();
  }

  // Marker write must complete before the next prompt reads it (functional
  // state, not observability) — unlike telemetry, we await this. The
  // writeSessionMarker itself swallows IO errors internally.
  await writeSessionMarker(updated);
  maybeSchedulePrune();

  if (!decision.inject) {
    return { block: null, decision, marker: updated };
  }
  let block: string | null = null;
  try {
    block = composeCaptureReminderBlock(buildCaptureReminder());
  } catch {
    /* over-budget content; drop block, still log decision below */
    block = null;
  }
  return { block, decision, marker: updated };
}

export async function hookUserPromptSubmitCommand(): Promise<void> {
  const startedAt = Date.now();
  const prompt = process.env.CLAUDE_USER_PROMPT ?? '';
  if (!prompt) return;

  const marker = await findProjectMarker();
  if (!marker) return;

  const cfg = await loadHookGlobalConfig();
  if (!cfg) return;

  // FR-037: more-restrictive-wins. Project disable cannot be overridden by user.
  const projectOverrides = readOverrides(marker.raw);
  const userOverrides = readOverrides(cfg.raw);
  const augmentDisabled =
    projectOverrides.per_prompt_augmentation === false ||
    userOverrides.per_prompt_augmentation === false;

  // Capture-reminder runs independently of augmentation toggle: a project
  // can disable backend search but still want capture reminders, and vice
  // versa. Resolved via their own config keys.
  const reminderConfig = resolveCaptureReminderConfig(
    readCaptureReminderOverrides(marker.raw),
    readCaptureReminderOverrides(cfg.raw),
  );

  const sessionId = process.env.CLAUDE_SESSION_ID;
  const parts: string[] = [];

  // 1. Capture-reminder decision (does not block on backend; runs in parallel
  //    conceptually but sequentially in code so we own the order in stdout).
  if (sessionId) {
    try {
      const result = await evaluateCaptureReminder(
        prompt,
        sessionId,
        reminderConfig,
        new Date(),
      );
      if (result.block) {
        void record('capture_reminder_injected', {
          org_id: cfg.orgId,
          project_id: marker.projectId,
          metadata: {
            session_id: sessionId,
            turn_count: result.decision.newTurnCount,
          },
        });
      } else if (result.decision.reason !== 'eligible') {
        void record('capture_reminder_skipped', {
          org_id: cfg.orgId,
          project_id: marker.projectId,
          metadata: {
            session_id: sessionId,
            reason: result.decision.reason,
            turn_count: result.decision.newTurnCount,
          },
        });
      }
      if (result.block) {
        parts.push(result.block);
      }
    } catch (err) {
      void record('hook_failure', {
        org_id: cfg.orgId,
        project_id: marker.projectId,
        error_message: `capture_reminder_failed: ${(err as Error).message ?? 'unknown'}`,
      });
    }
  } else {
    void record('hook_failure', {
      org_id: cfg.orgId,
      project_id: marker.projectId,
      error_message: 'session_id_missing',
    });
  }

  // 2. Backend search (Branch A–E). Skipped when augment disabled or apiKey missing.
  let searchBlock: string | null = null;
  if (!augmentDisabled && cfg.apiKey) {
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
        searchBlock = outcome.block!;
        void record('prompt_search_hit', {
          org_id: cfg.orgId,
          project_id: marker.projectId,
          latency_ms: Date.now() - startedAt,
        });
        break;
      case 'no_results':
      case 'all_below_threshold':
        void record('prompt_search_miss_threshold', {
          org_id: cfg.orgId,
          project_id: marker.projectId,
          latency_ms: Date.now() - startedAt,
          metadata: { raw_count: outcome.rawCount },
        });
        break;
      case 'all_over_budget':
        void record('prompt_search_miss_budget', {
          org_id: cfg.orgId,
          project_id: marker.projectId,
          latency_ms: Date.now() - startedAt,
          metadata: { above_threshold_count: outcome.aboveThresholdCount },
        });
        break;
      case 'timeout':
        void record('prompt_search_timeout', {
          org_id: cfg.orgId,
          project_id: marker.projectId,
          latency_ms: Date.now() - startedAt,
        });
        break;
      case 'fetch_failed':
        void record('hook_failure', {
          org_id: cfg.orgId,
          project_id: marker.projectId,
          latency_ms: Date.now() - startedAt,
          error_message: 'augment fetch failed',
        });
        break;
    }
  }

  // 3. Compose final additionalContext: search results FIRST (reference),
  //    capture reminder LAST (actionable instruction — recency bias).
  const emitParts: string[] = [];
  if (searchBlock) emitParts.push(searchBlock);
  emitParts.push(...parts);
  if (emitParts.length > 0) {
    emitContext(emitParts.join('\n\n'));
  }
}
