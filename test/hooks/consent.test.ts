import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  loadConsent,
  saveConsent,
  transitionConsent,
  isDay30AnniversaryDue,
  detectSelfHosted,
  type TelemetryConsentRecord,
} from '../../src/hooks/consent.js';

let tempHome: string;
let prevValisHome: string | undefined;

beforeEach(async () => {
  tempHome = await mkdtemp(join(tmpdir(), 'valis-consent-test-'));
  prevValisHome = process.env.VALIS_HOME;
  process.env.VALIS_HOME = tempHome;
});

afterEach(async () => {
  if (prevValisHome === undefined) delete process.env.VALIS_HOME;
  else process.env.VALIS_HOME = prevValisHome;
  await rm(tempHome, { recursive: true, force: true });
});

describe('hooks/consent — state machine', () => {
  it('first-touch accept_default produces accepted_30day_window with 30d anniversary', () => {
    const now = new Date('2026-05-06T00:00:00Z');
    const rec = transitionConsent(null, 'accept_default', { isSelfHosted: false, now });
    expect(rec.consent_state).toBe('accepted_30day_window');
    expect(rec.transmission_active).toBe(true);
    const ann = new Date(rec.day_30_anniversary);
    expect(ann.getTime()).toBe(now.getTime() + 30 * 24 * 3600 * 1000);
  });

  it('self-hosted accept_default keeps transmission OFF (consent on, transmit off)', () => {
    const rec = transitionConsent(null, 'accept_default', { isSelfHosted: true });
    expect(rec.consent_state).toBe('accepted_30day_window');
    expect(rec.transmission_active).toBe(false);
    expect(rec.is_self_hosted).toBe(true);
  });

  it('first-touch decline → declined state, transmission off', () => {
    const rec = transitionConsent(null, 'decline');
    expect(rec.consent_state).toBe('declined');
    expect(rec.transmission_active).toBe(false);
  });

  it('continue_after_30day promotes 30day_window → accepted_indefinite', () => {
    const start = transitionConsent(null, 'accept_default', { isSelfHosted: false });
    const promoted = transitionConsent(start, 'continue_after_30day');
    expect(promoted.consent_state).toBe('accepted_indefinite');
    expect(promoted.transmission_active).toBe(true);
  });

  it('stop_after_30day demotes 30day_window → stopped_after_30day', () => {
    const start = transitionConsent(null, 'accept_default', { isSelfHosted: false });
    const stopped = transitionConsent(start, 'stop_after_30day');
    expect(stopped.consent_state).toBe('stopped_after_30day');
    expect(stopped.transmission_active).toBe(false);
  });

  it('continue_after_30day from non-30day state throws', () => {
    const start = transitionConsent(null, 'accept_default', { isSelfHosted: false });
    const indefinite = transitionConsent(start, 'continue_after_30day');
    expect(() => transitionConsent(indefinite, 'continue_after_30day')).toThrow();
  });

  it('config_set_off + config_set_on round-trip preserves installation_id', () => {
    const initial = transitionConsent(null, 'accept_default', { isSelfHosted: false });
    const off = transitionConsent(initial, 'config_set_off');
    const back = transitionConsent(off, 'config_set_on');
    expect(off.consent_state).toBe('stopped_after_30day');
    expect(back.consent_state).toBe('accepted_indefinite');
    expect(back.installation_id).toBe(initial.installation_id);
  });

  it('illegal transition from null state throws', () => {
    expect(() => transitionConsent(null, 'continue_after_30day')).toThrow();
  });
});

describe('hooks/consent — day 30 anniversary', () => {
  it('returns true at exactly day 30', () => {
    const start = new Date('2026-05-06T00:00:00Z');
    const rec = transitionConsent(null, 'accept_default', { now: start, isSelfHosted: false });
    const day30 = new Date(start.getTime() + 30 * 24 * 3600 * 1000);
    expect(isDay30AnniversaryDue(rec, day30)).toBe(true);
  });

  it('returns false before day 30', () => {
    const start = new Date('2026-05-06T00:00:00Z');
    const rec = transitionConsent(null, 'accept_default', { now: start, isSelfHosted: false });
    const day29 = new Date(start.getTime() + 29 * 24 * 3600 * 1000);
    expect(isDay30AnniversaryDue(rec, day29)).toBe(false);
  });

  it('returns false after migration to accepted_indefinite', () => {
    const start = new Date('2026-05-06T00:00:00Z');
    const rec = transitionConsent(null, 'accept_default', { now: start, isSelfHosted: false });
    const promoted = transitionConsent(rec, 'continue_after_30day');
    const day40 = new Date(start.getTime() + 40 * 24 * 3600 * 1000);
    expect(isDay30AnniversaryDue(promoted, day40)).toBe(false);
  });

  it('returns false on null record', () => {
    expect(isDay30AnniversaryDue(null)).toBe(false);
  });
});

describe('hooks/consent — detectSelfHosted', () => {
  it('hosted krukit.co → not self-hosted', () => {
    expect(detectSelfHosted('https://valis.krukit.co')).toBe(false);
    expect(detectSelfHosted('https://api.krukit.co')).toBe(false);
  });

  it('local docker compose → self-hosted', () => {
    expect(detectSelfHosted('http://localhost:54321')).toBe(true);
    expect(detectSelfHosted('http://supabase.local')).toBe(true);
  });

  it('missing/invalid URL → self-hosted (defensive default)', () => {
    expect(detectSelfHosted(undefined)).toBe(true);
    expect(detectSelfHosted('not-a-url')).toBe(true);
  });
});

describe('hooks/consent — persistence', () => {
  it('round-trip via save/load preserves all fields', async () => {
    const rec: TelemetryConsentRecord = transitionConsent(null, 'accept_default', {
      isSelfHosted: false,
    });
    await saveConsent(rec);
    const loaded = await loadConsent();
    expect(loaded).toEqual(rec);
  });

  it('written file has 0600 permissions on POSIX', async () => {
    if (process.platform === 'win32') return;
    const rec = transitionConsent(null, 'accept_default', { isSelfHosted: false });
    await saveConsent(rec);
    const s = await stat(join(tempHome, 'consent.json'));
    expect(s.mode & 0o777).toBe(0o600);
  });

  it('load returns null when file does not exist', async () => {
    expect(await loadConsent()).toBeNull();
  });
});
