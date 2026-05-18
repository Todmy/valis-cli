/**
 * Per-session marker file: tracks turn count, token accumulator, and
 * reminder injection state across hook invocations of a single Claude
 * Code session.
 *
 * Storage: ~/.valis/session-markers/<sessionId>.json (mode 0o600).
 *
 * Pure decision logic (`shouldInjectCaptureReminder`, `isWorkBearingPrompt`)
 * is split from IO so the hook handler is fully unit-testable without
 * touching the filesystem. IO functions follow the telemetry pattern:
 * swallow errors, never crash the hook.
 *
 * Atomic write via temp-file + rename — partial writes would corrupt the
 * marker and force "default to inject" on every prompt, defeating the
 * single-shot-per-session contract.
 *
 * Schema v2 (2026-05-18) — adds token-density-based scheduling:
 *   - `prompt_tokens_accumulated` — cheap counter, summed from each user
 *     prompt's char-estimate. Hot-path check: only read transcript when
 *     this counter (plus an agent-output multiplier proxy) projects we
 *     are near the firing threshold.
 *   - `last_full_count_value` / `last_full_count_at_byte` — cached exact
 *     transcript token count + transcript byte size at that read. Lets
 *     us skip re-reading if file unchanged.
 *   - `last_reminder_tokens` — exact total at the most recent reminder
 *     fire. The delta vs current total is the actual firing trigger.
 *
 * v1 markers auto-migrate by defaulting all new fields to 0.
 */

import { mkdir, readFile, rename, unlink, writeFile, readdir, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { sessionMarkerDir, sessionMarkerPath } from './paths.js';

export const SESSION_MARKER_SCHEMA_VERSION = 2;

// Legacy turn-based defaults — preserved as a fallback when the transcript
// file is unreachable (e.g., test environment, IO error, or a future host
// that doesn't emit `transcript_path`).
export const DEFAULT_MIN_TURN = 5;
export const DEFAULT_INTERVAL_TURNS = 10;

// Token-based defaults (primary signal in schema v2). Calibrated so:
//   - First reminder fires after roughly one substantive exchange
//     (typical complex prompt 500-1500 tokens + agent response 500-2500
//     tokens → first reminder lands on turn 2-3).
//   - Subsequent reminders space out by ~1.5 substantive exchanges.
export const DEFAULT_MIN_TOKENS = 2000;
export const DEFAULT_INTERVAL_TOKENS = 3000;

// Minimum turn before we even consider firing — ensures at least one agent
// response sits in the transcript when the first reminder lands.
export const DEFAULT_MIN_TURN_FLOOR = 1;

// Cheap-path threshold: skip reading the transcript when the prompt-only
// accumulator projects we are below this fraction of the firing threshold.
// 0.4 balances false-skips (under-counting when agent generates a lot
// relative to user) against transcript IO frequency.
const CHEAP_SKIP_FRACTION = 0.4;

// Char-budget heuristic mirroring budget.ts:estimateTokens — kept inline
// to avoid a circular import path during marker (de)serialization tests.
const CHARS_PER_TOKEN = 4;

const MIN_QUALIFYING_LENGTH = 24;
const STALE_MARKER_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const PRUNE_PROBABILITY = 0.05;

export interface SessionMarker {
  session_id: string;
  first_seen_at: string;
  last_seen_at: string;
  turn_count: number;
  reminder_count: number;
  last_reminder_turn: number | null;
  last_reminder_at: string | null;
  /** v2: running sum of estimated tokens from user prompts only (cheap path). */
  prompt_tokens_accumulated: number;
  /** v2: exact transcript token count at the most recent full read. */
  last_full_count_value: number;
  /** v2: transcript file size at the most recent full read. */
  last_full_count_at_byte: number;
  /** v2: exact transcript token count when the last reminder fired. */
  last_reminder_tokens: number;
  schema_version: typeof SESSION_MARKER_SCHEMA_VERSION;
}

export interface CaptureReminderConfig {
  enabled: boolean;
  /** Legacy turn-based first-shot floor. Used as fallback only. */
  minTurn: number;
  /** Legacy turn-based interval. Used as fallback only. */
  intervalTurns: number;
  /** v2: estimated transcript-token delta required for the first reminder. */
  minTokens: number;
  /** v2: estimated transcript-token delta required for subsequent reminders. */
  intervalTokens: number;
  /** v2: never fire before this turn count (ensures ≥1 agent response logged). */
  minTurnFloor: number;
}

/** External signal the handler computes before calling `shouldInjectCaptureReminder`. */
export interface TranscriptSnapshot {
  /** Exact total tokens parsed from the JSONL transcript at this moment. */
  totalTokens: number;
  /** Transcript file size in bytes at this read. */
  totalBytes: number;
}

export type SkipReason =
  | 'disabled'
  | 'non_qualifying_prompt'
  | 'below_turn_floor'
  | 'tokens_below_threshold'
  // Legacy turn-based fallbacks — emitted only when transcript snapshot
  // is unavailable.
  | 'below_turn_threshold'
  | 'within_interval';

export interface CaptureReminderDecision {
  inject: boolean;
  reason: 'eligible' | SkipReason;
  newTurnCount: number;
  /** Estimated tokens to persist if firing — null when not applicable. */
  newReminderTokens?: number;
  /** Latest cached transcript snapshot — null when caller skipped the read. */
  newFullCount?: { value: number; atByte: number };
}

/**
 * Build a fresh marker for an unseen session. ISO timestamps caller-provided
 * so tests can pass a fixed clock.
 */
export function freshMarker(sessionId: string, now: Date): SessionMarker {
  const ts = now.toISOString();
  return {
    session_id: sessionId,
    first_seen_at: ts,
    last_seen_at: ts,
    turn_count: 0,
    reminder_count: 0,
    last_reminder_turn: null,
    last_reminder_at: null,
    prompt_tokens_accumulated: 0,
    last_full_count_value: 0,
    last_full_count_at_byte: 0,
    last_reminder_tokens: 0,
    schema_version: SESSION_MARKER_SCHEMA_VERSION,
  };
}

/**
 * Prompts that don't represent meaningful work-bearing turns:
 *   - shorter than 24 chars after trim
 *   - starting with `/` (slash-commands like /help, /clear)
 *
 * Used to filter shallow Q&A from the turn counter so the reminder
 * doesn't fire on a session of one-liners.
 */
export function isWorkBearingPrompt(prompt: string): boolean {
  const trimmed = prompt.trim();
  if (trimmed.length < MIN_QUALIFYING_LENGTH) return false;
  if (trimmed.startsWith('/')) return false;
  return true;
}

/**
 * Decide whether to inject a capture-reminder this prompt.
 *
 * Hybrid scheduling (v2):
 *   1. Disabled / non-qualifying / below turn floor → skip.
 *   2. Compute cheap projection: marker's prompt accumulator + the current
 *      prompt's tokens. If `transcriptSnapshot` is null, fall back to the
 *      legacy turn-based logic — this preserves Phase A behaviour in test
 *      environments that don't write a transcript.
 *   3. With transcript snapshot present: actual token delta vs
 *      `last_reminder_tokens` decides firing. The cheap projection only
 *      gates whether the caller bothered to read the transcript (skip-fast
 *      optimization in the hot path).
 */
export function shouldInjectCaptureReminder(
  marker: SessionMarker,
  prompt: string,
  config: CaptureReminderConfig,
  transcriptSnapshot?: TranscriptSnapshot | null,
): CaptureReminderDecision {
  if (!config.enabled) {
    return { inject: false, reason: 'disabled', newTurnCount: marker.turn_count };
  }
  const qualifying = isWorkBearingPrompt(prompt);
  if (!qualifying) {
    return {
      inject: false,
      reason: 'non_qualifying_prompt',
      newTurnCount: marker.turn_count,
    };
  }
  const newTurnCount = marker.turn_count + 1;

  // Hard turn floor — never fire before we have at least one logged exchange.
  if (newTurnCount < Math.max(1, config.minTurnFloor)) {
    return {
      inject: false,
      reason: 'below_turn_floor',
      newTurnCount,
    };
  }

  // Legacy fallback path — transcript not available, use turn-based.
  if (!transcriptSnapshot) {
    const firstShot = marker.reminder_count === 0 && newTurnCount >= config.minTurn;
    const intervalElapsed =
      marker.reminder_count > 0 &&
      marker.last_reminder_turn !== null &&
      newTurnCount - marker.last_reminder_turn >= config.intervalTurns;
    if (firstShot || intervalElapsed) {
      return { inject: true, reason: 'eligible', newTurnCount };
    }
    if (marker.reminder_count === 0) {
      return { inject: false, reason: 'below_turn_threshold', newTurnCount };
    }
    return { inject: false, reason: 'within_interval', newTurnCount };
  }

  // Token-based primary path.
  const tokensDelta = transcriptSnapshot.totalTokens - marker.last_reminder_tokens;
  const threshold =
    marker.reminder_count === 0 ? config.minTokens : config.intervalTokens;

  if (tokensDelta >= threshold) {
    return {
      inject: true,
      reason: 'eligible',
      newTurnCount,
      newReminderTokens: transcriptSnapshot.totalTokens,
      newFullCount: {
        value: transcriptSnapshot.totalTokens,
        atByte: transcriptSnapshot.totalBytes,
      },
    };
  }

  return {
    inject: false,
    reason: 'tokens_below_threshold',
    newTurnCount,
    newFullCount: {
      value: transcriptSnapshot.totalTokens,
      atByte: transcriptSnapshot.totalBytes,
    },
  };
}

/**
 * Heuristic: should the caller read the transcript file before invoking
 * `shouldInjectCaptureReminder`?
 *
 * Returns false (skip transcript read) when the cheap projection is far
 * below the firing threshold — i.e., the prompt accumulator since the
 * last reminder, scaled by an agent-output multiplier, is below
 * `CHEAP_SKIP_FRACTION` of the threshold.
 *
 * Agent responses typically run 1-5x the size of the user prompt that
 * triggered them. We use a 3x multiplier in the projection so that a
 * single complex prompt (`~500 tokens` written) projects to `~2000`
 * total exchange tokens, comfortably above the 0.4 × 2000 = 800
 * trip-wire — meaning we *do* read the transcript at that point.
 */
export function shouldReadTranscript(
  marker: SessionMarker,
  prompt: string,
  config: CaptureReminderConfig,
): boolean {
  if (!config.enabled) return false;
  if (!isWorkBearingPrompt(prompt)) return false;

  // Hard turn floor — no point reading transcript on the very first prompt
  // if we cannot fire anyway.
  if (marker.turn_count + 1 < Math.max(1, config.minTurnFloor)) {
    return false;
  }

  // First eligible call after a fresh marker (or after baseline never set)
  // → always read to establish a transcript baseline. The cheap-path
  // projection that follows can only be meaningful once we know the prior
  // total. ~0.5-3ms read cost is acceptable on first-fire-window prompts.
  if (marker.last_full_count_value === 0 && marker.last_full_count_at_byte === 0) {
    return true;
  }

  const promptTokens = Math.ceil(prompt.length / CHARS_PER_TOKEN);
  const projectedAccum = marker.prompt_tokens_accumulated + promptTokens;
  // 3× agent-output multiplier projection.
  const projectedTotal = marker.last_full_count_value + projectedAccum * 3;
  const projectedDelta = projectedTotal - marker.last_reminder_tokens;

  const threshold =
    marker.reminder_count === 0 ? config.minTokens : config.intervalTokens;

  return projectedDelta >= threshold * CHEAP_SKIP_FRACTION;
}

/**
 * Apply a fired-reminder side-effect to a marker. Pure — caller persists.
 */
export function applyReminderFire(
  marker: SessionMarker,
  newTurnCount: number,
  newReminderTokens: number,
  newFullCount: { value: number; atByte: number } | undefined,
  now: Date,
): SessionMarker {
  return {
    ...marker,
    turn_count: newTurnCount,
    reminder_count: marker.reminder_count + 1,
    last_reminder_turn: newTurnCount,
    last_reminder_at: now.toISOString(),
    last_reminder_tokens: newReminderTokens,
    last_full_count_value: newFullCount?.value ?? marker.last_full_count_value,
    last_full_count_at_byte: newFullCount?.atByte ?? marker.last_full_count_at_byte,
    last_seen_at: now.toISOString(),
    prompt_tokens_accumulated: 0,
  };
}

/**
 * Apply a not-fired turn update to a marker. Pure — caller persists.
 */
export function applyTurnAdvance(
  marker: SessionMarker,
  newTurnCount: number,
  promptTokens: number,
  newFullCount: { value: number; atByte: number } | undefined,
  now: Date,
): SessionMarker {
  return {
    ...marker,
    turn_count: newTurnCount,
    last_seen_at: now.toISOString(),
    prompt_tokens_accumulated: marker.prompt_tokens_accumulated + promptTokens,
    last_full_count_value: newFullCount?.value ?? marker.last_full_count_value,
    last_full_count_at_byte: newFullCount?.atByte ?? marker.last_full_count_at_byte,
  };
}

/**
 * Read marker JSON. Returns null on any failure (missing file, parse error,
 * permission denied). The caller substitutes a fresh marker.
 *
 * Schema migration: v1 markers (no token fields) are read, then upgraded in
 * memory by defaulting the new fields to 0. Persisted form is rewritten on
 * the next write — no separate migration pass needed.
 */
export async function readSessionMarker(sessionId: string): Promise<SessionMarker | null> {
  try {
    const raw = await readFile(sessionMarkerPath(sessionId), 'utf-8');
    const parsed = JSON.parse(raw) as Partial<SessionMarker> & Record<string, unknown>;
    if (
      typeof parsed.session_id !== 'string' ||
      typeof parsed.turn_count !== 'number' ||
      typeof parsed.reminder_count !== 'number'
    ) {
      return null;
    }
    const version = (parsed as { schema_version?: number }).schema_version;
    if (version !== 1 && version !== SESSION_MARKER_SCHEMA_VERSION) {
      // Unknown future version — refuse to interpret rather than guess.
      return null;
    }
    // Forward-fill v1 → v2 with zero token state.
    return {
      session_id: parsed.session_id,
      first_seen_at: parsed.first_seen_at ?? new Date().toISOString(),
      last_seen_at: parsed.last_seen_at ?? new Date().toISOString(),
      turn_count: parsed.turn_count,
      reminder_count: parsed.reminder_count,
      last_reminder_turn: parsed.last_reminder_turn ?? null,
      last_reminder_at: parsed.last_reminder_at ?? null,
      prompt_tokens_accumulated:
        typeof parsed.prompt_tokens_accumulated === 'number'
          ? parsed.prompt_tokens_accumulated
          : 0,
      last_full_count_value:
        typeof parsed.last_full_count_value === 'number' ? parsed.last_full_count_value : 0,
      last_full_count_at_byte:
        typeof parsed.last_full_count_at_byte === 'number'
          ? parsed.last_full_count_at_byte
          : 0,
      last_reminder_tokens:
        typeof parsed.last_reminder_tokens === 'number' ? parsed.last_reminder_tokens : 0,
      schema_version: SESSION_MARKER_SCHEMA_VERSION,
    };
  } catch {
    return null;
  }
}

/**
 * Atomic write: temp file + rename. Mode 0o600. mkdir -p the parent. Errors
 * are swallowed — hook must not crash on disk-full or permission issues.
 */
export async function writeSessionMarker(marker: SessionMarker): Promise<void> {
  const finalPath = sessionMarkerPath(marker.session_id);
  const tmpPath = `${finalPath}.${process.pid}.tmp`;
  try {
    await mkdir(dirname(finalPath), { recursive: true, mode: 0o700 });
    await writeFile(tmpPath, JSON.stringify(marker), { mode: 0o600 });
    await rename(tmpPath, finalPath);
  } catch {
    /* swallow; next prompt retries */
  }
}

/**
 * Best-effort cleanup of stale marker files. Called opportunistically by the
 * hook with low probability to avoid filesystem churn. Returns the number of
 * markers unlinked (for tests; runtime callers ignore the count).
 */
export async function pruneStaleMarkers(
  maxAgeMs: number = STALE_MARKER_AGE_MS,
  now: Date = new Date(),
): Promise<number> {
  let pruned = 0;
  try {
    const dir = sessionMarkerDir();
    const entries = await readdir(dir);
    const cutoff = now.getTime() - maxAgeMs;
    for (const name of entries) {
      if (!name.endsWith('.json')) continue;
      const fullPath = `${dir}/${name}`;
      try {
        const st = await stat(fullPath);
        if (st.mtimeMs < cutoff) {
          await unlink(fullPath);
          pruned++;
        }
      } catch {
        /* per-file errors swallowed */
      }
    }
  } catch {
    /* dir missing or unreadable */
  }
  return pruned;
}

/**
 * Helper for the hook: roll the dice and prune in the background if we win.
 * `VALIS_DISABLE_PRUNE=1` short-circuits — used by tests to avoid race with
 * tmpdir cleanup, and available as an escape hatch in production.
 */
export function maybeSchedulePrune(): void {
  if (process.env.VALIS_DISABLE_PRUNE === '1') return;
  if (Math.random() < PRUNE_PROBABILITY) {
    void pruneStaleMarkers();
  }
}
