/**
 * Best-effort POST helper for backend adoption-metrics ingestion.
 *
 * Reads consent from ~/.valis/consent.json (written by consent.ts in US4).
 * Short-circuits when transmission_active is false. Never throws — telemetry
 * must never crash a hook.
 *
 * Bounded retry per-batch: max 3 attempts with exponential backoff.
 */

import { readFile } from 'node:fs/promises';
import { consentPath, configPath } from '../hooks/paths.js';

export interface AdoptionEvent {
  event_type: string;
  count?: number;
  occurred_at?: string;
  metadata?: Record<string, unknown>;
}

interface ConsentRecord {
  installation_id: string;
  consent_state: string;
  transmission_active: boolean;
}

interface ValisConfig {
  org_id?: string;
  member_api_key?: string;
  api_key?: string;
  supabase_url?: string;
  api_base_url?: string;
}

const DEFAULT_API_BASE = 'https://valis.krukit.co';

async function loadConsent(): Promise<ConsentRecord | null> {
  try {
    const data = await readFile(consentPath(), 'utf-8');
    return JSON.parse(data) as ConsentRecord;
  } catch {
    return null;
  }
}

async function loadGlobalConfig(): Promise<ValisConfig | null> {
  try {
    const data = await readFile(configPath(), 'utf-8');
    return JSON.parse(data) as ValisConfig;
  } catch {
    return null;
  }
}

export interface EmitResult {
  ok: boolean;
  reason?: 'consent_off' | 'no_config' | 'no_auth' | 'http_error' | 'network_error' | 'no_consent_record';
  status?: number;
}

/**
 * Post a batch of adoption events to the backend.
 *
 * Phase A: emits *only* when consent.transmission_active is true. Self-hosted
 * installs can flip this off at install time; hosted defaults to ON for the
 * 30-day window (FR-022).
 */
export async function emitAdoptionEvents(
  projectId: string,
  events: AdoptionEvent[],
): Promise<EmitResult> {
  if (events.length === 0) return { ok: true };

  const consent = await loadConsent();
  if (consent === null) {
    // No consent record yet — Phase A startup before init has decided.
    return { ok: false, reason: 'no_consent_record' };
  }
  if (!consent.transmission_active) {
    return { ok: false, reason: 'consent_off' };
  }

  const cfg = await loadGlobalConfig();
  if (!cfg) return { ok: false, reason: 'no_config' };
  const apiKey = cfg.member_api_key || cfg.api_key;
  if (!apiKey) return { ok: false, reason: 'no_auth' };

  const base = cfg.api_base_url || DEFAULT_API_BASE;
  const url = `${base}/api/projects/${encodeURIComponent(projectId)}/metrics`;
  const body = JSON.stringify({
    installation_id: consent.installation_id,
    events,
  });

  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body,
      });
      if (res.ok || res.status === 207) return { ok: true, status: res.status };
      // 4xx → don't retry (validation, auth)
      if (res.status >= 400 && res.status < 500) {
        return { ok: false, reason: 'http_error', status: res.status };
      }
      // 5xx → backoff and retry
    } catch {
      // network — backoff and retry
    }
    if (attempt < maxAttempts) {
      const backoffMs = 250 * 2 ** (attempt - 1);
      await new Promise((r) => setTimeout(r, backoffMs));
    }
  }
  return { ok: false, reason: 'network_error' };
}
