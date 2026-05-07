/**
 * TelemetryConsentRecord state machine — feature 023 v2 US4.
 *
 * Per data-model.md §4. Persists to ~/.valis/consent.json (0600).
 *
 * State graph:
 *   (missing) → pending → accepted_30day_window → accepted_indefinite
 *                       → declined                ↘ stopped_after_30day
 *                                                ↗
 *                accepted_indefinite ↔ stopped_after_30day
 *                                       (config set telemetry on/off)
 */

import { readFile, writeFile, mkdir, chmod, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { consentPath } from './paths.js';
import { record as recordTelemetry } from './telemetry.js';

export type ConsentState =
  | 'pending'
  | 'accepted_30day_window'
  | 'accepted_indefinite'
  | 'declined'
  | 'stopped_after_30day';

export interface TelemetryConsentRecord {
  installation_id: string;
  consent_state: ConsentState;
  consent_decided_at: string;
  day_30_anniversary: string;
  is_self_hosted: boolean;
  transmission_active: boolean;
}

export type ConsentAction =
  | 'accept_default'
  | 'decline'
  | 'continue_after_30day'
  | 'stop_after_30day'
  | 'config_set_on'
  | 'config_set_off';

const DAY_MS = 24 * 60 * 60 * 1000;

export async function loadConsent(): Promise<TelemetryConsentRecord | null> {
  try {
    const data = await readFile(consentPath(), 'utf-8');
    return JSON.parse(data) as TelemetryConsentRecord;
  } catch {
    return null;
  }
}

export async function saveConsent(record: TelemetryConsentRecord): Promise<void> {
  const target = consentPath();
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  const tmp = `${target}.${randomBytes(6).toString('hex')}.tmp`;
  await writeFile(tmp, JSON.stringify(record, null, 2), {
    encoding: 'utf-8',
    mode: 0o600,
  });
  try {
    await chmod(tmp, 0o600);
  } catch {
    /* non-POSIX best-effort */
  }
  await rename(tmp, target);
}

/**
 * Apply an action to a consent record (or create one from scratch).
 *
 * Throws on illegal transition; the caller should handle errors gracefully.
 */
export function transitionConsent(
  current: TelemetryConsentRecord | null,
  action: ConsentAction,
  options: { isSelfHosted?: boolean; now?: Date } = {},
): TelemetryConsentRecord {
  const now = options.now ?? new Date();
  const nowIso = now.toISOString();

  if (current === null) {
    // First-touch: only accept_default / decline make sense.
    const installationId = randomUUID();
    const isSelfHosted = options.isSelfHosted ?? false;
    if (action === 'accept_default') {
      return {
        installation_id: installationId,
        consent_state: 'accepted_30day_window',
        consent_decided_at: nowIso,
        day_30_anniversary: new Date(now.getTime() + 30 * DAY_MS).toISOString(),
        is_self_hosted: isSelfHosted,
        transmission_active: !isSelfHosted, // self-hosted defaults to OFF
      };
    }
    if (action === 'decline') {
      return {
        installation_id: installationId,
        consent_state: 'declined',
        consent_decided_at: nowIso,
        day_30_anniversary: new Date(now.getTime() + 30 * DAY_MS).toISOString(),
        is_self_hosted: isSelfHosted,
        transmission_active: false,
      };
    }
    throw new Error(`Cannot apply ${action} to missing consent record`);
  }

  // Mutate based on current state + action.
  switch (action) {
    case 'accept_default':
      // Re-applying accept_default after a stop transitions to indefinite.
      return {
        ...current,
        consent_state: 'accepted_indefinite',
        consent_decided_at: nowIso,
        transmission_active: !current.is_self_hosted,
      };
    case 'decline':
      return {
        ...current,
        consent_state: 'declined',
        consent_decided_at: nowIso,
        transmission_active: false,
      };
    case 'continue_after_30day':
      if (current.consent_state !== 'accepted_30day_window') {
        throw new Error(
          `continue_after_30day requires accepted_30day_window, got ${current.consent_state}`,
        );
      }
      return {
        ...current,
        consent_state: 'accepted_indefinite',
        consent_decided_at: nowIso,
        transmission_active: !current.is_self_hosted,
      };
    case 'stop_after_30day':
      if (current.consent_state !== 'accepted_30day_window') {
        throw new Error(
          `stop_after_30day requires accepted_30day_window, got ${current.consent_state}`,
        );
      }
      return {
        ...current,
        consent_state: 'stopped_after_30day',
        consent_decided_at: nowIso,
        transmission_active: false,
      };
    case 'config_set_on':
      // From any non-active state to indefinite.
      return {
        ...current,
        consent_state: 'accepted_indefinite',
        consent_decided_at: nowIso,
        transmission_active: !current.is_self_hosted,
      };
    case 'config_set_off':
      return {
        ...current,
        consent_state: 'stopped_after_30day',
        consent_decided_at: nowIso,
        transmission_active: false,
      };
  }
}

/**
 * Returns true when the engineer should be prompted to confirm continuation.
 * Only fires for accounts in the 30-day window past the anniversary date.
 */
export function isDay30AnniversaryDue(
  record: TelemetryConsentRecord | null,
  now: Date = new Date(),
): boolean {
  if (!record) return false;
  if (record.consent_state !== 'accepted_30day_window') return false;
  return now.getTime() >= Date.parse(record.day_30_anniversary);
}

/**
 * Detect whether the install is self-hosted by inspecting the supabase_url
 * in ~/.valis/config.json. Hosted accounts use *.krukit.co; everything else
 * is treated as self-hosted (OSS docker compose, dev clusters, etc.).
 */
export function detectSelfHosted(supabaseUrl: string | undefined): boolean {
  if (!supabaseUrl) return true;
  try {
    const u = new URL(supabaseUrl);
    return !/(^|\.)krukit\.co$/.test(u.hostname);
  } catch {
    return true;
  }
}

export function newInstallationId(): string {
  return randomUUID();
}

/**
 * Interactive consent dialog used by `valis init` (T043 / FR-022).
 *
 * Idempotent: if a consent record already exists with state ≠ 'pending',
 * the dialog is silent. First-time install always shows the disclosure.
 *
 * Returns true when consent was decided (accept_default OR decline) on
 * this invocation, false when no decision was needed.
 */
export interface ConsentDialogIO {
  /** Render the disclosure block. */
  show: (text: string) => void;
  /** Prompt the engineer; resolve to true=accept, false=decline. */
  ask: (question: string, defaultValue: boolean) => Promise<boolean>;
}

export const CONSENT_DISCLOSURE = `Valis records local counters so you can see whether the team actually
uses captured decisions.

Collected:     event counts, latency p50/p95, cache hit rate
Not collected: prompt text, decision IDs, per-engineer data

Hosted:        ON for 30 days, then ON indefinitely unless you opt out.
Self-hosted:   local recording only, no transmission.

Change anytime:  valis config set telemetry {on|off}`;

export async function runConsentDialog(
  io: ConsentDialogIO,
  options: { isSelfHosted: boolean; now?: Date } = { isSelfHosted: false },
): Promise<boolean> {
  const existing = await loadConsent();
  if (existing && existing.consent_state !== 'pending') {
    return false; // already decided; nothing to ask
  }

  io.show(CONSENT_DISCLOSURE);

  const accepted = await io.ask(
    options.isSelfHosted
      ? 'Accept? (self-hosted: transmission OFF) [Y/n]'
      : 'Accept? [Y/n]',
    true,
  );

  const action = accepted ? 'accept_default' : 'decline';
  const next = transitionConsent(existing, action, {
    isSelfHosted: options.isSelfHosted,
    now: options.now,
  });
  await saveConsent(next);
  void recordTelemetry(
    accepted ? 'telemetry_consent_accepted' : 'telemetry_consent_declined',
  );
  return true;
}

/**
 * Day-30 anniversary check. Called once per non-hook CLI invocation.
 *
 * - Returns immediately if no consent record (init hasn't run).
 * - Returns immediately if consent state is anything other than
 *   accepted_30day_window OR if the anniversary hasn't elapsed.
 * - For hosted accounts, auto-continues (default = keep transmitting).
 * - For self-hosted, auto-stops (default = silent).
 *
 * Both branches transition the record + emit a telemetry event so the
 * change is auditable. This is non-interactive — the engineer sees it
 * via `valis status --telemetry`.
 */
export async function maybeFireDay30(now: Date = new Date()): Promise<void> {
  const current = await loadConsent();
  if (!isDay30AnniversaryDue(current, now)) return;
  const decision = current!.is_self_hosted ? 'stop_after_30day' : 'continue_after_30day';
  let next;
  try {
    next = transitionConsent(current, decision, { now });
  } catch {
    return;
  }
  await saveConsent(next);
  void recordTelemetry(
    decision === 'continue_after_30day'
      ? 'telemetry_day_30_continued'
      : 'telemetry_day_30_stopped',
  );
}
