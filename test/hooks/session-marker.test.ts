/**
 * Unit tests for session-marker.ts pure functions + IO helpers.
 *
 * Pure-function tests do not touch the filesystem. IO tests use a
 * VALIS_HOME-override pointing at a per-test tmp directory.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, stat, utimes, readdir, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_INTERVAL_TOKENS,
  DEFAULT_INTERVAL_TURNS,
  DEFAULT_MIN_TOKENS,
  DEFAULT_MIN_TURN,
  DEFAULT_MIN_TURN_FLOOR,
  applyReminderFire,
  applyTurnAdvance,
  freshMarker,
  isWorkBearingPrompt,
  pruneStaleMarkers,
  readSessionMarker,
  SESSION_MARKER_SCHEMA_VERSION,
  shouldInjectCaptureReminder,
  shouldReadTranscript,
  writeSessionMarker,
  type CaptureReminderConfig,
  type SessionMarker,
} from '../../src/hooks/session-marker.js';
import { sessionMarkerDir, sessionMarkerPath } from '../../src/hooks/paths.js';

const FIXED_CLOCK = new Date('2026-05-12T10:00:00.000Z');
const ENABLED_CFG: CaptureReminderConfig = {
  enabled: true,
  minTurn: DEFAULT_MIN_TURN,
  intervalTurns: DEFAULT_INTERVAL_TURNS,
  minTokens: DEFAULT_MIN_TOKENS,
  intervalTokens: DEFAULT_INTERVAL_TOKENS,
  minTurnFloor: DEFAULT_MIN_TURN_FLOOR,
};

describe('isWorkBearingPrompt', () => {
  it('rejects short prompts under 24 chars', () => {
    expect(isWorkBearingPrompt('hi')).toBe(false);
    expect(isWorkBearingPrompt('what is foo')).toBe(false);
    expect(isWorkBearingPrompt(' '.repeat(30))).toBe(false);
  });

  it('rejects prompts starting with a slash command', () => {
    expect(isWorkBearingPrompt('/help me with this task please')).toBe(false);
    expect(isWorkBearingPrompt('/clear my session for me right now')).toBe(false);
  });

  it('accepts substantive prompts of 24+ chars', () => {
    expect(isWorkBearingPrompt('please refactor this function')).toBe(true);
    expect(isWorkBearingPrompt('я хочу зробити цей рефакторинг сьогодні')).toBe(true);
  });
});

describe('shouldInjectCaptureReminder', () => {
  it('returns disabled when config.enabled is false', () => {
    const marker = freshMarker('s1', FIXED_CLOCK);
    const decision = shouldInjectCaptureReminder(
      marker,
      'this is a meaningful prompt for testing',
      { ...ENABLED_CFG, enabled: false },
    );
    expect(decision).toMatchObject({ inject: false, reason: 'disabled', newTurnCount: 0 });
  });

  it('returns non_qualifying_prompt and does not increment turn for short prompts', () => {
    const marker = freshMarker('s1', FIXED_CLOCK);
    const decision = shouldInjectCaptureReminder(marker, '?', ENABLED_CFG);
    expect(decision).toMatchObject({
      inject: false,
      reason: 'non_qualifying_prompt',
      newTurnCount: 0,
    });
  });

  it('increments turn count on each qualifying prompt before minTurn', () => {
    let marker = freshMarker('s1', FIXED_CLOCK);
    for (let i = 1; i < DEFAULT_MIN_TURN; i++) {
      const decision = shouldInjectCaptureReminder(
        marker,
        'this is a meaningful prompt number ' + i,
        ENABLED_CFG,
      );
      expect(decision.inject).toBe(false);
      expect(decision.reason).toBe('below_turn_threshold');
      expect(decision.newTurnCount).toBe(i);
      marker = { ...marker, turn_count: decision.newTurnCount };
    }
  });

  it('injects on the minTurn-th qualifying prompt', () => {
    const marker: SessionMarker = {
      ...freshMarker('s1', FIXED_CLOCK),
      turn_count: DEFAULT_MIN_TURN - 1,
    };
    const decision = shouldInjectCaptureReminder(
      marker,
      'this is the meaningful fifth prompt now',
      ENABLED_CFG,
    );
    expect(decision).toMatchObject({
      inject: true,
      reason: 'eligible',
      newTurnCount: DEFAULT_MIN_TURN,
    });
  });

  it('suppresses subsequent prompts within the interval window', () => {
    const marker: SessionMarker = {
      ...freshMarker('s1', FIXED_CLOCK),
      turn_count: DEFAULT_MIN_TURN,
      reminder_count: 1,
      last_reminder_turn: DEFAULT_MIN_TURN,
      last_reminder_at: FIXED_CLOCK.toISOString(),
    };
    for (let i = 1; i < DEFAULT_INTERVAL_TURNS; i++) {
      const decision = shouldInjectCaptureReminder(
        marker,
        'meaningful follow-up prompt number ' + i,
        ENABLED_CFG,
      );
      expect(decision.inject).toBe(false);
      expect(decision.reason).toBe('within_interval');
    }
  });

  it('re-injects after intervalTurns since last reminder', () => {
    const marker: SessionMarker = {
      ...freshMarker('s1', FIXED_CLOCK),
      turn_count: DEFAULT_MIN_TURN + DEFAULT_INTERVAL_TURNS - 1,
      reminder_count: 1,
      last_reminder_turn: DEFAULT_MIN_TURN,
      last_reminder_at: FIXED_CLOCK.toISOString(),
    };
    const decision = shouldInjectCaptureReminder(
      marker,
      'meaningful prompt that should re-trigger reminder',
      ENABLED_CFG,
    );
    expect(decision).toMatchObject({
      inject: true,
      reason: 'eligible',
      newTurnCount: DEFAULT_MIN_TURN + DEFAULT_INTERVAL_TURNS,
    });
  });

  it('respects custom minTurn config', () => {
    const marker: SessionMarker = {
      ...freshMarker('s1', FIXED_CLOCK),
      turn_count: 1,
    };
    const decision = shouldInjectCaptureReminder(
      marker,
      'this is a meaningful prompt that fits',
      { enabled: true, minTurn: 2, intervalTurns: DEFAULT_INTERVAL_TURNS },
    );
    expect(decision.inject).toBe(true);
    expect(decision.newTurnCount).toBe(2);
  });
});

describe('readSessionMarker / writeSessionMarker (IO)', () => {
  let tmpHome: string;
  const origHome = process.env.VALIS_HOME;

  beforeEach(async () => {
    tmpHome = await mkdtemp(join(tmpdir(), 'valis-session-marker-'));
    process.env.VALIS_HOME = tmpHome;
  });

  afterEach(async () => {
    if (origHome === undefined) delete process.env.VALIS_HOME;
    else process.env.VALIS_HOME = origHome;
    await rm(tmpHome, { recursive: true, force: true });
  });

  it('readSessionMarker returns null when file is missing', async () => {
    const result = await readSessionMarker('nonexistent-session');
    expect(result).toBeNull();
  });

  it('writeSessionMarker creates parent directory + atomic file', async () => {
    const marker = freshMarker('write-test', FIXED_CLOCK);
    await writeSessionMarker(marker);
    const path = sessionMarkerPath('write-test');
    const raw = await readFile(path, 'utf-8');
    expect(JSON.parse(raw)).toMatchObject({
      session_id: 'write-test',
      turn_count: 0,
      schema_version: SESSION_MARKER_SCHEMA_VERSION,
    });
    // No leftover .tmp file:
    const entries = await readdir(sessionMarkerDir());
    expect(entries.filter((e) => e.endsWith('.tmp'))).toEqual([]);
  });

  it('readSessionMarker round-trips a written marker', async () => {
    const original = freshMarker('round-trip', FIXED_CLOCK);
    await writeSessionMarker(original);
    const read = await readSessionMarker('round-trip');
    expect(read).toEqual(original);
  });

  it('readSessionMarker returns null on corrupt JSON', async () => {
    await mkdir(sessionMarkerDir(), { recursive: true });
    await writeFile(sessionMarkerPath('corrupt'), 'not valid json {{{', { mode: 0o600 });
    const result = await readSessionMarker('corrupt');
    expect(result).toBeNull();
  });

  it('readSessionMarker returns null on schema mismatch', async () => {
    await mkdir(sessionMarkerDir(), { recursive: true });
    await writeFile(
      sessionMarkerPath('wrong-schema'),
      JSON.stringify({ session_id: 'x', schema_version: 99 }),
      { mode: 0o600 },
    );
    const result = await readSessionMarker('wrong-schema');
    expect(result).toBeNull();
  });

  it('writeSessionMarker file mode is 0o600 (POSIX only)', async () => {
    if (process.platform === 'win32') return;
    const marker = freshMarker('mode-test', FIXED_CLOCK);
    await writeSessionMarker(marker);
    const st = await stat(sessionMarkerPath('mode-test'));
    // mode bits low 9 are perm; mask with 0o777
    expect(st.mode & 0o777).toBe(0o600);
  });

  it('readSessionMarker migrates v1 markers in-memory (defaults token fields to 0)', async () => {
    await mkdir(sessionMarkerDir(), { recursive: true });
    const v1Marker = {
      session_id: 'legacy-v1',
      first_seen_at: FIXED_CLOCK.toISOString(),
      last_seen_at: FIXED_CLOCK.toISOString(),
      turn_count: 3,
      reminder_count: 1,
      last_reminder_turn: 3,
      last_reminder_at: FIXED_CLOCK.toISOString(),
      schema_version: 1,
    };
    await writeFile(sessionMarkerPath('legacy-v1'), JSON.stringify(v1Marker), { mode: 0o600 });

    const read = await readSessionMarker('legacy-v1');
    expect(read).not.toBeNull();
    expect(read!.schema_version).toBe(SESSION_MARKER_SCHEMA_VERSION);
    expect(read!.prompt_tokens_accumulated).toBe(0);
    expect(read!.last_full_count_value).toBe(0);
    expect(read!.last_full_count_at_byte).toBe(0);
    expect(read!.last_reminder_tokens).toBe(0);
    // Existing v1 fields preserved verbatim.
    expect(read!.turn_count).toBe(3);
    expect(read!.reminder_count).toBe(1);
    expect(read!.last_reminder_turn).toBe(3);
  });
});

describe('shouldReadTranscript (cheap-path projection)', () => {
  const longPrompt = 'a'.repeat(120); // ~30 tokens

  it('returns false when capture-reminder is disabled', () => {
    const marker = freshMarker('s', FIXED_CLOCK);
    const decision = shouldReadTranscript(marker, longPrompt, {
      ...ENABLED_CFG,
      enabled: false,
    });
    expect(decision).toBe(false);
  });

  it('returns false for non-qualifying prompts', () => {
    const marker = freshMarker('s', FIXED_CLOCK);
    expect(shouldReadTranscript(marker, '/clear', ENABLED_CFG)).toBe(false);
    expect(shouldReadTranscript(marker, 'short', ENABLED_CFG)).toBe(false);
  });

  it('returns false when next turn would be below minTurnFloor', () => {
    const marker = freshMarker('s', FIXED_CLOCK);
    const decision = shouldReadTranscript(marker, longPrompt, {
      ...ENABLED_CFG,
      minTurnFloor: 5,
    });
    expect(decision).toBe(false);
  });

  it('returns true on first eligible call even with low projection (baseline read)', () => {
    // Fresh marker has last_full_count_value === 0 — we always read once
    // to establish a transcript baseline before the cheap projection can
    // meaningfully decide.
    const marker = freshMarker('s', FIXED_CLOCK);
    expect(shouldReadTranscript(marker, longPrompt, ENABLED_CFG)).toBe(true);
  });

  it('returns false when projection is far below threshold (post-baseline)', () => {
    // After baseline read, last_full_count_value is set. Now projection
    // gates the read. Small accumulator + tiny prompt → far below 800.
    const marker: SessionMarker = {
      ...freshMarker('s', FIXED_CLOCK),
      turn_count: 2,
      last_full_count_value: 200,
      last_full_count_at_byte: 1000,
      prompt_tokens_accumulated: 30,
    };
    // projected total = 200 + (30 + 30) × 3 = 380 → delta 380 < 800.
    expect(shouldReadTranscript(marker, longPrompt, ENABLED_CFG)).toBe(false);
  });

  it('returns true when projection crosses the cheap-skip line', () => {
    // Simulate sufficient accumulator + prior transcript content so
    // projection lands above 0.4 × minTokens (= 800).
    const marker: SessionMarker = {
      ...freshMarker('s', FIXED_CLOCK),
      turn_count: 2,
      prompt_tokens_accumulated: 200,
      last_full_count_value: 200,
    };
    // projected total = 200 + (200 + 30) × 3 ≈ 890 > 800
    expect(shouldReadTranscript(marker, longPrompt, ENABLED_CFG)).toBe(true);
  });
});

describe('shouldInjectCaptureReminder — token-based path', () => {
  const longPrompt = 'a'.repeat(120);

  it('skips firing when transcript token delta below minTokens (first reminder)', () => {
    const marker = freshMarker('s', FIXED_CLOCK);
    const decision = shouldInjectCaptureReminder(marker, longPrompt, ENABLED_CFG, {
      totalTokens: 1500, // below 2000 threshold
      totalBytes: 4000,
    });
    expect(decision.inject).toBe(false);
    expect(decision.reason).toBe('tokens_below_threshold');
  });

  it('fires when transcript token delta crosses minTokens', () => {
    const marker = freshMarker('s', FIXED_CLOCK);
    const decision = shouldInjectCaptureReminder(marker, longPrompt, ENABLED_CFG, {
      totalTokens: 2500,
      totalBytes: 10000,
    });
    expect(decision.inject).toBe(true);
    expect(decision.reason).toBe('eligible');
    expect(decision.newReminderTokens).toBe(2500);
    expect(decision.newFullCount).toEqual({ value: 2500, atByte: 10000 });
  });

  it('uses intervalTokens (not minTokens) for subsequent reminders', () => {
    const marker: SessionMarker = {
      ...freshMarker('s', FIXED_CLOCK),
      reminder_count: 1,
      last_reminder_tokens: 2000,
      last_reminder_turn: 3,
      turn_count: 3,
    };
    // Delta = 4500 - 2000 = 2500 — below 3000 interval, should NOT fire.
    const skip = shouldInjectCaptureReminder(marker, longPrompt, ENABLED_CFG, {
      totalTokens: 4500,
      totalBytes: 12000,
    });
    expect(skip.inject).toBe(false);
    expect(skip.reason).toBe('tokens_below_threshold');

    // Delta = 5500 - 2000 = 3500 — above 3000 interval, should fire.
    const fire = shouldInjectCaptureReminder(marker, longPrompt, ENABLED_CFG, {
      totalTokens: 5500,
      totalBytes: 14000,
    });
    expect(fire.inject).toBe(true);
    expect(fire.reason).toBe('eligible');
  });

  it('respects turn floor — never fires before minTurnFloor', () => {
    const marker = freshMarker('s', FIXED_CLOCK);
    const decision = shouldInjectCaptureReminder(
      marker,
      longPrompt,
      { ...ENABLED_CFG, minTurnFloor: 5 },
      { totalTokens: 50000, totalBytes: 100000 }, // huge transcript
    );
    expect(decision.inject).toBe(false);
    expect(decision.reason).toBe('below_turn_floor');
  });

  it('falls back to turn-based when transcript snapshot is missing', () => {
    const marker: SessionMarker = {
      ...freshMarker('s', FIXED_CLOCK),
      turn_count: 4,
    };
    // newTurnCount=5 ≥ minTurn=5 → fire via legacy path.
    const decision = shouldInjectCaptureReminder(marker, longPrompt, ENABLED_CFG);
    expect(decision.inject).toBe(true);
    expect(decision.reason).toBe('eligible');
    expect(decision.newReminderTokens).toBeUndefined();
  });
});

describe('applyReminderFire / applyTurnAdvance (pure)', () => {
  it('applyReminderFire updates reminder bookkeeping + clears prompt accumulator', () => {
    const marker: SessionMarker = {
      ...freshMarker('s', FIXED_CLOCK),
      turn_count: 2,
      prompt_tokens_accumulated: 450,
      last_full_count_value: 1800,
      last_full_count_at_byte: 5000,
    };
    const after = applyReminderFire(
      marker,
      3,
      2200,
      { value: 2200, atByte: 7500 },
      new Date('2026-05-12T11:00:00.000Z'),
    );
    expect(after.turn_count).toBe(3);
    expect(after.reminder_count).toBe(1);
    expect(after.last_reminder_turn).toBe(3);
    expect(after.last_reminder_tokens).toBe(2200);
    expect(after.last_full_count_value).toBe(2200);
    expect(after.last_full_count_at_byte).toBe(7500);
    expect(after.prompt_tokens_accumulated).toBe(0); // cleared after fire
    expect(after.last_reminder_at).toBe('2026-05-12T11:00:00.000Z');
  });

  it('applyTurnAdvance increments accumulator without touching reminder state', () => {
    const marker: SessionMarker = {
      ...freshMarker('s', FIXED_CLOCK),
      turn_count: 2,
      prompt_tokens_accumulated: 300,
      reminder_count: 1,
      last_reminder_turn: 1,
      last_reminder_tokens: 800,
    };
    const after = applyTurnAdvance(
      marker,
      3,
      75,
      undefined,
      new Date('2026-05-12T11:00:00.000Z'),
    );
    expect(after.turn_count).toBe(3);
    expect(after.prompt_tokens_accumulated).toBe(375);
    // Reminder state untouched
    expect(after.reminder_count).toBe(1);
    expect(after.last_reminder_turn).toBe(1);
    expect(after.last_reminder_tokens).toBe(800);
  });

  it('applyTurnAdvance preserves last_full_count fields when undefined passed', () => {
    const marker: SessionMarker = {
      ...freshMarker('s', FIXED_CLOCK),
      last_full_count_value: 1500,
      last_full_count_at_byte: 4000,
    };
    const after = applyTurnAdvance(marker, 1, 10, undefined, FIXED_CLOCK);
    expect(after.last_full_count_value).toBe(1500);
    expect(after.last_full_count_at_byte).toBe(4000);
  });
});

describe('pruneStaleMarkers', () => {
  let tmpHome: string;
  const origHome = process.env.VALIS_HOME;

  beforeEach(async () => {
    tmpHome = await mkdtemp(join(tmpdir(), 'valis-prune-'));
    process.env.VALIS_HOME = tmpHome;
  });

  afterEach(async () => {
    if (origHome === undefined) delete process.env.VALIS_HOME;
    else process.env.VALIS_HOME = origHome;
    await rm(tmpHome, { recursive: true, force: true });
  });

  it('unlinks markers older than maxAgeMs but keeps fresh ones', async () => {
    const now = new Date('2026-05-12T10:00:00.000Z');
    await writeSessionMarker(freshMarker('fresh', now));
    await writeSessionMarker(freshMarker('old-one', now));
    await writeSessionMarker(freshMarker('old-two', now));

    const oldTs = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000); // 10 days
    await utimes(sessionMarkerPath('old-one'), oldTs, oldTs);
    await utimes(sessionMarkerPath('old-two'), oldTs, oldTs);

    const pruned = await pruneStaleMarkers(7 * 24 * 60 * 60 * 1000, now);
    expect(pruned).toBe(2);
    const remaining = await readdir(sessionMarkerDir());
    expect(remaining.sort()).toEqual(['fresh.json']);
  });

  it('returns 0 when no markers exist', async () => {
    const pruned = await pruneStaleMarkers(1, new Date());
    expect(pruned).toBe(0);
  });

  it('ignores non-json files in the marker directory', async () => {
    const now = new Date('2026-05-12T10:00:00.000Z');
    await mkdir(sessionMarkerDir(), { recursive: true });
    await writeFile(join(sessionMarkerDir(), 'README.txt'), 'do not delete me');
    const oldTs = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    await utimes(join(sessionMarkerDir(), 'README.txt'), oldTs, oldTs);
    const pruned = await pruneStaleMarkers(7 * 24 * 60 * 60 * 1000, now);
    expect(pruned).toBe(0);
  });
});
