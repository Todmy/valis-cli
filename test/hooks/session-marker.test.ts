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
  DEFAULT_INTERVAL_TURNS,
  DEFAULT_MIN_TURN,
  freshMarker,
  isWorkBearingPrompt,
  pruneStaleMarkers,
  readSessionMarker,
  SESSION_MARKER_SCHEMA_VERSION,
  shouldInjectCaptureReminder,
  writeSessionMarker,
  type SessionMarker,
} from '../../src/hooks/session-marker.js';
import { sessionMarkerDir, sessionMarkerPath } from '../../src/hooks/paths.js';

const FIXED_CLOCK = new Date('2026-05-12T10:00:00.000Z');
const ENABLED_CFG = {
  enabled: true,
  minTurn: DEFAULT_MIN_TURN,
  intervalTurns: DEFAULT_INTERVAL_TURNS,
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
