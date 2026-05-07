/**
 * T050 — integration test for the telemetry consent dialog.
 *
 * Exercises runConsentDialog with a stub IO so the state-machine + telemetry
 * write happens via the same code path init.ts uses.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  runConsentDialog,
  loadConsent,
  saveConsent,
  transitionConsent,
  CONSENT_DISCLOSURE,
} from '../../src/hooks/consent.js';

let tempHome: string;
let prevValisHome: string | undefined;

beforeEach(async () => {
  tempHome = await mkdtemp(join(tmpdir(), 'valis-init-consent-'));
  prevValisHome = process.env.VALIS_HOME;
  process.env.VALIS_HOME = tempHome;
});

afterEach(async () => {
  if (prevValisHome === undefined) delete process.env.VALIS_HOME;
  else process.env.VALIS_HOME = prevValisHome;
  await rm(tempHome, { recursive: true, force: true });
});

function makeIO(answer: boolean | 'default') {
  const shown: string[] = [];
  const asked: string[] = [];
  return {
    shown,
    asked,
    io: {
      show: (text: string) => {
        shown.push(text);
      },
      ask: async (question: string, defaultValue: boolean) => {
        asked.push(question);
        return answer === 'default' ? defaultValue : answer;
      },
    },
  };
}

describe('runConsentDialog — first-touch flow', () => {
  it('accept_default writes accepted_30day_window for hosted accounts', async () => {
    const { io, shown, asked } = makeIO(true);
    const decided = await runConsentDialog(io, { isSelfHosted: false });
    expect(decided).toBe(true);
    expect(shown[0]).toBe(CONSENT_DISCLOSURE);
    expect(asked[0]).toMatch(/Accept\?/);
    const consent = await loadConsent();
    expect(consent?.consent_state).toBe('accepted_30day_window');
    expect(consent?.transmission_active).toBe(true);
    expect(consent?.is_self_hosted).toBe(false);
  });

  it('decline writes declined state with transmission off', async () => {
    const { io } = makeIO(false);
    await runConsentDialog(io, { isSelfHosted: false });
    const consent = await loadConsent();
    expect(consent?.consent_state).toBe('declined');
    expect(consent?.transmission_active).toBe(false);
  });

  it('self-hosted accept keeps transmission OFF (consent on, transmit off)', async () => {
    const { io, asked } = makeIO(true);
    await runConsentDialog(io, { isSelfHosted: true });
    expect(asked[0]).toMatch(/transmission OFF/i);
    const consent = await loadConsent();
    expect(consent?.consent_state).toBe('accepted_30day_window');
    expect(consent?.transmission_active).toBe(false);
    expect(consent?.is_self_hosted).toBe(true);
  });

  it('default empty answer respects defaultValue=true', async () => {
    const { io } = makeIO('default');
    await runConsentDialog(io, { isSelfHosted: false });
    const consent = await loadConsent();
    expect(consent?.consent_state).toBe('accepted_30day_window');
  });
});

describe('runConsentDialog — idempotency', () => {
  it('does not re-prompt when consent already accepted', async () => {
    // Pre-seed the consent file.
    const initial = transitionConsent(null, 'accept_default', { isSelfHosted: false });
    await saveConsent(initial);

    const { io, shown } = makeIO(false);
    const decided = await runConsentDialog(io, { isSelfHosted: false });
    expect(decided).toBe(false); // no decision needed
    expect(shown.length).toBe(0); // disclosure not re-shown
    const consent = await loadConsent();
    expect(consent?.consent_state).toBe('accepted_30day_window');
  });

  it('does not re-prompt when consent already declined', async () => {
    const initial = transitionConsent(null, 'decline');
    await saveConsent(initial);

    const { io, shown } = makeIO(true);
    const decided = await runConsentDialog(io, { isSelfHosted: false });
    expect(decided).toBe(false);
    expect(shown.length).toBe(0);
  });
});

describe('runConsentDialog — telemetry side-effect', () => {
  // recordTelemetry is fire-and-forget; poll the log file briefly after
  // the dialog returns so we don't race the async append.
  async function pollTelemetry(maxAttempts = 20): Promise<string[]> {
    for (let i = 0; i < maxAttempts; i++) {
      try {
        const log = await readFile(join(tempHome, 'telemetry.jsonl'), 'utf-8');
        if (log.trim().length > 0) {
          return log
            .split('\n')
            .filter(Boolean)
            .map((l) => JSON.parse(l).event as string);
        }
      } catch {
        /* not written yet */
      }
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error('telemetry file never appeared');
  }

  it('records telemetry_consent_accepted on accept', async () => {
    const { io } = makeIO(true);
    await runConsentDialog(io, { isSelfHosted: false });
    const events = await pollTelemetry();
    expect(events).toContain('telemetry_consent_accepted');
  });

  it('records telemetry_consent_declined on decline', async () => {
    const { io } = makeIO(false);
    await runConsentDialog(io, { isSelfHosted: false });
    const events = await pollTelemetry();
    expect(events).toContain('telemetry_consent_declined');
  });
});
