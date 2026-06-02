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
 * In addition to the search block, a token-density-scheduled capture
 * reminder may be appended (see session-marker.ts for the trigger rule).
 * The two pieces are combined into a single `additionalContext` string and
 * emitted once at the end of the handler.
 *
 * Constitution III: any failure → empty stdout, exit 0.
 *
 * Token-based scheduling (schema v2 / 2026-05-18):
 *   - Claude Code passes a `transcript_path` field via stdin JSON for this
 *     hook event. We read it once per fire (off the hot path when projection
 *     says we're far below the threshold) and use the exact JSONL token
 *     estimate as the firing signal. Cheap path (prompt accumulator alone)
 *     gates whether the transcript read happens at all.
 */

import { findProjectMarker } from '../config/project.js';
import { loadHookGlobalConfig } from './context.js';
import { augment } from './augment.js';
import { record } from './telemetry.js';
import { buildCaptureReminder } from '../channel/push.js';
import {
  composeActiveProjectBlock,
  composeCaptureReminderBlock,
  composeUpdateAvailableBlock,
  composeUpdateInstalledBlock,
} from './inject-block.js';
import { readFile, unlink, writeFile, mkdir, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { valisHome } from './paths.js';
import { readTranscriptTokens } from './transcript.js';
import {
  DEFAULT_INTERVAL_TOKENS,
  DEFAULT_INTERVAL_TURNS,
  DEFAULT_MIN_TOKENS,
  DEFAULT_MIN_TURN,
  DEFAULT_MIN_TURN_FLOOR,
  applyReminderFire,
  applyTurnAdvance,
  freshMarker,
  maybeSchedulePrune,
  readSessionMarker,
  shouldInjectCaptureReminder,
  shouldReadTranscript,
  writeSessionMarker,
  type CaptureReminderConfig,
  type CaptureReminderDecision,
  type SessionMarker,
  type TranscriptSnapshot,
} from './session-marker.js';

/** Hook-specific overrides we look for in `.valis.json` and `~/.valis/config.json`. */
interface PerPromptOverrides {
  per_prompt_augmentation?: boolean;
  per_prompt_threshold?: number;
  per_prompt_budget?: number;
  /** #242: backend-search hard timeout in ms. Default 2500 (augment.ts). */
  per_prompt_timeout_ms?: number;
}

interface CaptureReminderOverrides {
  capture_reminder_enabled?: boolean;
  capture_reminder_min_turn?: number;
  capture_reminder_interval?: number;
  capture_reminder_min_tokens?: number;
  capture_reminder_interval_tokens?: number;
  capture_reminder_min_turn_floor?: number;
}

function readOverrides(raw: Record<string, unknown>): PerPromptOverrides {
  return {
    per_prompt_augmentation:
      typeof raw.per_prompt_augmentation === 'boolean' ? raw.per_prompt_augmentation : undefined,
    per_prompt_threshold:
      typeof raw.per_prompt_threshold === 'number' ? raw.per_prompt_threshold : undefined,
    per_prompt_budget:
      typeof raw.per_prompt_budget === 'number' ? raw.per_prompt_budget : undefined,
    per_prompt_timeout_ms:
      typeof raw.per_prompt_timeout_ms === 'number' ? raw.per_prompt_timeout_ms : undefined,
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
    capture_reminder_min_tokens:
      typeof raw.capture_reminder_min_tokens === 'number'
        ? raw.capture_reminder_min_tokens
        : undefined,
    capture_reminder_interval_tokens:
      typeof raw.capture_reminder_interval_tokens === 'number'
        ? raw.capture_reminder_interval_tokens
        : undefined,
    capture_reminder_min_turn_floor:
      typeof raw.capture_reminder_min_turn_floor === 'number'
        ? raw.capture_reminder_min_turn_floor
        : undefined,
  };
}

/**
 * Resolve capture-reminder config with more-restrictive-wins semantics:
 * project disable overrides user enable; project enable can still be
 * disabled by user. Individual numeric knobs prefer project value, fall
 * through to user, then to library default.
 */
function resolveCaptureReminderConfig(
  projectOverrides: CaptureReminderOverrides,
  userOverrides: CaptureReminderOverrides,
): CaptureReminderConfig {
  const enabled =
    projectOverrides.capture_reminder_enabled !== false &&
    userOverrides.capture_reminder_enabled !== false;
  return {
    enabled,
    minTurn:
      projectOverrides.capture_reminder_min_turn ??
      userOverrides.capture_reminder_min_turn ??
      DEFAULT_MIN_TURN,
    intervalTurns:
      projectOverrides.capture_reminder_interval ??
      userOverrides.capture_reminder_interval ??
      DEFAULT_INTERVAL_TURNS,
    minTokens:
      projectOverrides.capture_reminder_min_tokens ??
      userOverrides.capture_reminder_min_tokens ??
      DEFAULT_MIN_TOKENS,
    intervalTokens:
      projectOverrides.capture_reminder_interval_tokens ??
      userOverrides.capture_reminder_interval_tokens ??
      DEFAULT_INTERVAL_TOKENS,
    minTurnFloor:
      projectOverrides.capture_reminder_min_turn_floor ??
      userOverrides.capture_reminder_min_turn_floor ??
      DEFAULT_MIN_TURN_FLOOR,
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

/**
 * Read Claude Code's hook JSON envelope from stdin. The envelope is the
 * primary channel for hook payload in modern Claude Code builds; env vars
 * are a legacy/fallback path. Fields we consume:
 *   - `transcript_path` — token-density scheduler
 *   - `prompt` — user's submitted prompt (BUG #177: env var
 *     `CLAUDE_USER_PROMPT` is NOT set by current Claude Code; relying on
 *     it caused silent no-op in all real sessions)
 *   - `session_id` — capture-reminder marker key
 *
 * Returns null on any read or parse failure. Caller falls back to env vars
 * so test harnesses (which set env vars but no stdin envelope) still work.
 */
interface HookEnvelope {
  transcript_path?: string;
  prompt?: string;
  session_id?: string;
}

async function readHookEnvelope(): Promise<HookEnvelope | null> {
  // Empty stdin (tty / test harness) → null without blocking.
  if (process.stdin.isTTY) return null;

  return new Promise<HookEnvelope | null>((resolve) => {
    let buf = '';
    let resolved = false;
    // 50ms hard cap — Claude Code writes the envelope before invoking the
    // process, so any sane stdin should land within a few ms. The timeout
    // protects against environments where stdin is wired open but unused.
    const timer = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      resolve(null);
    }, 50);
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk) => {
      buf += chunk;
    });
    process.stdin.on('end', () => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      if (!buf.trim()) return resolve(null);
      try {
        const parsed = JSON.parse(buf) as HookEnvelope;
        resolve(parsed);
      } catch {
        resolve(null);
      }
    });
    process.stdin.on('error', () => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      resolve(null);
    });
  });
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
  transcriptPath: string | undefined,
  now: Date,
): Promise<{ block: string | null; decision: CaptureReminderDecision; marker: SessionMarker }> {
  const existing = (await readSessionMarker(sessionId)) ?? freshMarker(sessionId, now);

  // Cheap path: do we even need to read the transcript? Skip read entirely
  // when the projected delta is far below the firing threshold.
  let transcriptSnapshot: TranscriptSnapshot | null = null;
  if (transcriptPath && shouldReadTranscript(existing, prompt, config)) {
    transcriptSnapshot = await readTranscriptTokens(transcriptPath);
  }

  const decision = shouldInjectCaptureReminder(existing, prompt, config, transcriptSnapshot);

  const promptTokens = Math.ceil(prompt.length / 4);
  const updated: SessionMarker = decision.inject
    ? applyReminderFire(
        existing,
        decision.newTurnCount,
        decision.newReminderTokens ?? transcriptSnapshot?.totalTokens ?? existing.last_reminder_tokens,
        decision.newFullCount,
        now,
      )
    : applyTurnAdvance(existing, decision.newTurnCount, promptTokens, decision.newFullCount, now);

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

  // BUG #177: Claude Code does NOT set CLAUDE_USER_PROMPT env var — the
  // prompt arrives only via the stdin JSON envelope. Read envelope FIRST,
  // then prefer envelope fields with env-var fallback (test harness).
  const envelope = await readHookEnvelope();
  const prompt = envelope?.prompt ?? process.env.CLAUDE_USER_PROMPT ?? '';
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

  const sessionId = envelope?.session_id ?? process.env.CLAUDE_SESSION_ID;
  const parts: string[] = [];

  // 1. Capture-reminder decision (does not block on backend; runs in parallel
  //    conceptually but sequentially in code so we own the order in stdout).
  if (sessionId) {
    try {
      const result = await evaluateCaptureReminder(
        prompt,
        sessionId,
        reminderConfig,
        envelope?.transcript_path,
        new Date(),
      );
      if (result.block) {
        void record('capture_reminder_injected', {
          org_id: cfg.orgId,
          project_id: marker.projectId,
          metadata: {
            session_id: sessionId,
            turn_count: result.decision.newTurnCount,
            tokens: result.decision.newReminderTokens ?? null,
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
    const timeoutMs =
      projectOverrides.per_prompt_timeout_ms ?? userOverrides.per_prompt_timeout_ms;

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
      timeoutMs,
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

  // 3. Compose final additionalContext, in order:
  //    - <valis_update_installed> if the auto-installer (update-notifier.ts)
  //      spawned `npm i -g` since the last turn — visible signal that the
  //      CLI was upgraded. Stderr from session-start is not reliable in
  //      Claude Code's UI, so we surface the news via additionalContext
  //      (which IS shown to the agent and thereby to the user). Consumed
  //      once: the sentinel file is unlinked after we emit the block.
  //    - <valis_active_project> NEXT (~70 tokens) — standing scope every
  //      turn so the agent knows which project_id to pass to valis_* MCP
  //      tools (BUG #176 — plugin transport doesn't propagate this).
  //    - <valis_search_results> — relevance-driven reference material.
  //    - <channel capture_reminder> LAST — actionable instruction (recency
  //      bias keeps it in the agent's working memory for the immediate turn).
  const emitParts: string[] = [];
  const updateBlock = await consumeUpdatePendingMarker();
  if (updateBlock) emitParts.push(updateBlock);
  // BUG #178: once-per-session "newer CLI available" announcement for
  // version-manager users (nvm/volta/asdf/brew) where auto-install is
  // architecturally unsafe. Different semantics from update-pending: the
  // sentinel persists across sessions until the user actually upgrades
  // (cleared by `maybeNotifyOfUpdate` on the next session-start when
  // current >= latest). Per-session de-dup via `last_emitted_session_id`.
  if (sessionId) {
    const availableBlock = await consumeUpdateAvailableMarker(sessionId);
    if (availableBlock) emitParts.push(availableBlock);
  }
  emitParts.push(composeActiveProjectBlock(marker.projectId, marker.projectName));
  if (searchBlock) emitParts.push(searchBlock);
  emitParts.push(...parts);
  if (emitParts.length > 0) {
    emitContext(emitParts.join('\n\n'));
  }
}

/**
 * Read the auto-installer's pending-sentinel file (written by
 * `update-notifier.ts::spawnDetachedInstall`). If present and valid,
 * compose the <valis_update_installed> block and DELETE the sentinel —
 * one-shot semantics so the announcement appears exactly once after each
 * upgrade. Failures swallowed; Constitution III: never block.
 */
/**
 * BUG #178: Read the `update-available.json` sentinel. If it exists AND
 * has NOT yet been emitted for the current session, return the composed
 * block and flip `last_emitted_session_id` to the current session id so
 * subsequent prompts in the same session see nothing. The sentinel
 * itself persists across sessions until the user actually upgrades —
 * cleanup happens in `maybeNotifyOfUpdate` on the next session-start
 * once `cached.latest_version <= currentVersion`.
 *
 * Failures are swallowed (Constitution III). If the JSON is corrupt we
 * unlink it so we don't loop on bad data — same defensive pattern as
 * the update-pending consumer above.
 */
async function consumeUpdateAvailableMarker(currentSessionId: string): Promise<string | null> {
  const markerPath = join(valisHome(), 'cache', 'update-available.json');
  let raw: string;
  try {
    raw = await readFile(markerPath, 'utf-8');
  } catch {
    return null; // No sentinel — fast path, common case.
  }
  let parsed: {
    target_version?: string;
    current_version?: string;
    reason?: string;
    last_emitted_session_id?: string;
  };
  try {
    parsed = JSON.parse(raw) as typeof parsed;
  } catch {
    void unlink(markerPath).catch(() => undefined);
    return null;
  }
  const target = typeof parsed.target_version === 'string' ? parsed.target_version : null;
  const current = typeof parsed.current_version === 'string' ? parsed.current_version : null;
  const reasonRaw = parsed.reason;
  const reason: 'managed' | 'opt_out' | null =
    reasonRaw === 'managed' || reasonRaw === 'opt_out' ? reasonRaw : null;
  if (!target || !current || !reason) {
    void unlink(markerPath).catch(() => undefined);
    return null;
  }
  // De-dup: already emitted for this session → silent.
  if (parsed.last_emitted_session_id === currentSessionId) return null;

  // Compose first — if the composer throws (unexpected) we don't poison
  // the sentinel with a fake "emitted" timestamp.
  let block: string;
  try {
    block = composeUpdateAvailableBlock(target, current, reason);
  } catch {
    return null;
  }
  // Atomic-rename write so a concurrent read never sees a half-written file.
  try {
    const tmp = `${markerPath}.tmp`;
    await mkdir(dirname(markerPath), { recursive: true });
    await writeFile(
      tmp,
      JSON.stringify(
        { ...parsed, last_emitted_session_id: currentSessionId },
        null,
        2,
      ),
      'utf-8',
    );
    await rename(tmp, markerPath);
  } catch {
    // Marker write failed — return the block anyway so the user gets ONE
    // emission; next session will re-emit because flag never landed.
  }
  return block;
}

async function consumeUpdatePendingMarker(): Promise<string | null> {
  const markerPath = join(valisHome(), 'cache', 'update-pending.json');
  let raw: string;
  try {
    raw = await readFile(markerPath, 'utf-8');
  } catch {
    return null; // No pending update — overwhelmingly the common path.
  }
  let parsed: { target_version?: string; spawned_at?: string };
  try {
    parsed = JSON.parse(raw) as typeof parsed;
  } catch {
    // Corrupt sentinel — drop it so we don't loop on bad data.
    void unlink(markerPath).catch(() => undefined);
    return null;
  }
  const version = typeof parsed.target_version === 'string' ? parsed.target_version : null;
  const at = typeof parsed.spawned_at === 'string' ? parsed.spawned_at : null;
  if (!version || !at) {
    void unlink(markerPath).catch(() => undefined);
    return null;
  }
  // Best-effort delete BEFORE emitting so an exception in the composer
  // doesn't re-announce the upgrade on every prompt.
  void unlink(markerPath).catch(() => undefined);
  try {
    return composeUpdateInstalledBlock(version, at);
  } catch {
    return null;
  }
}
