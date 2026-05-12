/**
 * Per-session marker file: tracks turn count + reminder injection state
 * across hook invocations of a single Claude Code session.
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
 */

import { mkdir, readFile, rename, unlink, writeFile, readdir, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { sessionMarkerDir, sessionMarkerPath } from './paths.js';

export const SESSION_MARKER_SCHEMA_VERSION = 1;
export const DEFAULT_MIN_TURN = 5;
export const DEFAULT_INTERVAL_TURNS = 10;
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
  schema_version: typeof SESSION_MARKER_SCHEMA_VERSION;
}

export interface CaptureReminderConfig {
  enabled: boolean;
  minTurn: number;
  intervalTurns: number;
}

export type SkipReason =
  | 'disabled'
  | 'non_qualifying_prompt'
  | 'below_turn_threshold'
  | 'within_interval';

export interface CaptureReminderDecision {
  inject: boolean;
  reason: 'eligible' | SkipReason;
  newTurnCount: number;
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
 * Deterministic decision: inject reminder this prompt?
 *
 * Rule:
 *   inject if qualifying AND (
 *     (turn_count >= minTurn AND no reminder yet)
 *     OR
 *     (turns since last reminder >= intervalTurns)
 *   )
 *
 * Returns the new turn count so the caller can persist it (incremented
 * only for qualifying prompts).
 */
export function shouldInjectCaptureReminder(
  marker: SessionMarker,
  prompt: string,
  config: CaptureReminderConfig,
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
  const firstShot = marker.reminder_count === 0 && newTurnCount >= config.minTurn;
  const intervalElapsed =
    marker.reminder_count > 0 &&
    marker.last_reminder_turn !== null &&
    newTurnCount - marker.last_reminder_turn >= config.intervalTurns;

  if (firstShot || intervalElapsed) {
    return { inject: true, reason: 'eligible', newTurnCount };
  }
  if (marker.reminder_count === 0) {
    return {
      inject: false,
      reason: 'below_turn_threshold',
      newTurnCount,
    };
  }
  return {
    inject: false,
    reason: 'within_interval',
    newTurnCount,
  };
}

/**
 * Read marker JSON. Returns null on any failure (missing file, parse error,
 * permission denied). The caller substitutes a fresh marker.
 */
export async function readSessionMarker(sessionId: string): Promise<SessionMarker | null> {
  try {
    const raw = await readFile(sessionMarkerPath(sessionId), 'utf-8');
    const parsed = JSON.parse(raw) as SessionMarker;
    if (
      typeof parsed.session_id !== 'string' ||
      typeof parsed.turn_count !== 'number' ||
      typeof parsed.reminder_count !== 'number' ||
      parsed.schema_version !== SESSION_MARKER_SCHEMA_VERSION
    ) {
      return null;
    }
    return parsed;
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
