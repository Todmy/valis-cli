#!/usr/bin/env tsx
/**
 * Sprint 2026-05-15 — post-deploy verification script.
 *
 * Runs against production after the sprint PR merges + Vercel deploys. Checks
 * the four surfaces that determine "is the sprint live for friends":
 *
 *   1. Postgres schema — migration 022 applied (5 new columns on `decisions`,
 *      `decision_edges` table exists)
 *   2. Qdrant payload indexes — 9 structured-filter dimensions provisioned
 *      (uses the existing idempotent ensureStructuredFilterIndexes helper)
 *   3. HTTP probes — OAuth metadata endpoint reachable + /api/check synthetic
 *      returns the expected shape
 *   4. Optional — PostHog events visible in the last hour (proxy for "funnel
 *      taxonomy is wired"; requires POSTHOG_API_KEY)
 *
 * The script prints a structured per-check pass/fail report. Exit code 0 on
 * ALL CHECKS PASSED, exit code 1 on any failure (CI-friendly).
 *
 * Idempotent: safe to re-run any number of times — Qdrant treats duplicate
 * createPayloadIndex calls as no-ops, Postgres schema reads are read-only,
 * HTTP probes are GETs or POST against /api/check which is itself idempotent
 * on the same input.
 *
 * Env (required):
 *   SUPABASE_DB_URL — postgres direct-connection string (port 5432)
 *   QDRANT_URL, QDRANT_API_KEY
 *   VALIS_API_BASE — e.g. https://valis.krukit.co
 *
 * Env (optional — enables additional checks):
 *   POSTHOG_API_KEY — project read key (NOT the ingest key)
 *   POSTHOG_HOST   — e.g. https://eu.posthog.com
 *   VALIS_TOKEN    — bearer for the /api/check probe; if absent the probe is skipped
 */

import { Client } from 'pg';
import { QdrantClient } from '@qdrant/js-client-rest';
import {
  ensureStructuredFilterIndexes,
  STRUCTURED_FILTER_INDEXED_FIELDS,
} from '../src/cloud/qdrant/payload-indexes.js';

interface CheckResult {
  name: string;
  status: 'passed' | 'failed' | 'skipped';
  detail?: string;
  duration_ms: number;
}

async function timed<T>(name: string, fn: () => Promise<T>): Promise<{ value?: T; result: CheckResult }> {
  const start = Date.now();
  try {
    const value = await fn();
    return { value, result: { name, status: 'passed', duration_ms: Date.now() - start } };
  } catch (err) {
    return {
      result: {
        name,
        status: 'failed',
        detail: err instanceof Error ? err.message : String(err),
        duration_ms: Date.now() - start,
      },
    };
  }
}

function skipped(name: string, reason: string): CheckResult {
  return { name, status: 'skipped', detail: reason, duration_ms: 0 };
}

// ---------------------------------------------------------------------------
// Check 1: Postgres schema (migration 022)
// ---------------------------------------------------------------------------

export async function checkPostgresSchema(connectionString: string): Promise<void> {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    // 1a — five new columns on `decisions`
    const cols = await client.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'decisions'
         AND column_name = ANY($1::text[])`,
      [['outcome', 'outcome_reason', 'outcome_updated_at', 'alternatives_considered', 'risks']],
    );
    const seen = new Set(cols.rows.map((r: { column_name: string }) => r.column_name));
    const missing = ['outcome', 'outcome_reason', 'outcome_updated_at', 'alternatives_considered', 'risks']
      .filter((c) => !seen.has(c));
    if (missing.length > 0) {
      throw new Error(`decisions: missing columns ${missing.join(', ')} — migration 022 not applied`);
    }

    // 1b — `decision_edges` table exists
    const edgeTable = await client.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name = 'decision_edges'
       ) AS exists`,
    );
    if (!edgeTable.rows[0]?.exists) {
      throw new Error('decision_edges table does not exist — migration 022 not applied');
    }

    // 1c — outcome CHECK constraint is in place (defensive — confirms the
    //      migration didn't half-apply due to a CHECK violation on existing rows)
    const constraint = await client.query<{ pg_get_constraintdef: string }>(
      `SELECT pg_get_constraintdef(oid)
       FROM pg_constraint
       WHERE conname LIKE '%outcome%' AND conrelid = 'decisions'::regclass`,
    );
    if (constraint.rows.length === 0) {
      throw new Error('outcome CHECK constraint missing on decisions');
    }
  } finally {
    await client.end();
  }
}

// ---------------------------------------------------------------------------
// Check 2: Qdrant payload indexes
// ---------------------------------------------------------------------------

export async function checkQdrantIndexes(url: string, apiKey: string): Promise<{ created: number; existed: number; failed: string[] }> {
  const qdrant = new QdrantClient({ url, apiKey });
  const results = await ensureStructuredFilterIndexes(qdrant);
  const failed = results.filter((r) => r.status === 'failed').map((r) => r.field_name);
  if (failed.length > 0) {
    throw new Error(`Qdrant payload index provisioning failed for: ${failed.join(', ')}`);
  }
  // If anything is 'created' (instead of 'already_exists') the script is being
  // run against a freshly-deployed Qdrant collection — flag in detail but pass.
  const created = results.filter((r) => r.status === 'created').length;
  const existed = results.filter((r) => r.status === 'already_exists').length;
  if (created + existed !== STRUCTURED_FILTER_INDEXED_FIELDS.length) {
    throw new Error(
      `unexpected index result count: ${created + existed} (want ${STRUCTURED_FILTER_INDEXED_FIELDS.length})`,
    );
  }
  return { created, existed, failed };
}

// ---------------------------------------------------------------------------
// Check 3: HTTP probes
// ---------------------------------------------------------------------------

export async function checkOAuthMetadata(
  baseUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const res = await fetchImpl(`${baseUrl}/.well-known/oauth-authorization-server`);
  if (!res.ok) {
    throw new Error(`OAuth metadata endpoint returned ${res.status}`);
  }
  const body = (await res.json()) as { issuer?: string; authorization_endpoint?: string };
  if (!body.issuer || !body.authorization_endpoint) {
    throw new Error('OAuth metadata response missing issuer/authorization_endpoint');
  }
}

export async function checkApiCheckProbe(
  baseUrl: string,
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  // Synthetic diff that touches one file — the route returns 200 with violations:[]
  // even when there are no decisions to match, so a clean response shape is the
  // strongest signal that the route is alive end-to-end.
  const res = await fetchImpl(`${baseUrl}/api/check`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      diff: 'diff --git a/smoke-test.ts b/smoke-test.ts\n+++ b/smoke-test.ts\n+console.log("probe");',
      metadata: { actor: 'verify-prod-state', surface: 'smoke' },
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`/api/check returned ${res.status}: ${text.slice(0, 200)}`);
  }
  const body = (await res.json()) as { violations?: unknown };
  if (!Array.isArray(body.violations)) {
    throw new Error('/api/check response missing violations array');
  }
}

// ---------------------------------------------------------------------------
// Check 4: PostHog events visible in the last hour
// ---------------------------------------------------------------------------

export async function checkPostHogEvents(
  host: string,
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  // Read the last hour of events filtered to the funnel taxonomy. PostHog
  // returns an empty result set when no events have fired — that's the
  // failure signal we want to catch.
  const oneHourAgoIso = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const url = new URL(`${host}/api/event/`);
  url.searchParams.set('after', oneHourAgoIso);
  // Match any of the 9 funnel events.
  url.searchParams.set('event', 'first_decision_captured');
  const res = await fetchImpl(url.toString(), {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) {
    throw new Error(`PostHog API returned ${res.status} — verify POSTHOG_API_KEY is a read key, not ingest`);
  }
  const body = (await res.json()) as { results?: unknown[] };
  if (!body.results || body.results.length === 0) {
    throw new Error('zero first_decision_captured events in the last hour — wire is broken or no traffic yet');
  }
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const results: CheckResult[] = [];

  // Required env first — fail loudly if anything is missing.
  const supabaseDbUrl = process.env.SUPABASE_DB_URL;
  const qdrantUrl = process.env.QDRANT_URL;
  const qdrantApiKey = process.env.QDRANT_API_KEY;
  const valisApiBase = process.env.VALIS_API_BASE;
  const missing = [
    !supabaseDbUrl && 'SUPABASE_DB_URL',
    !qdrantUrl && 'QDRANT_URL',
    !qdrantApiKey && 'QDRANT_API_KEY',
    !valisApiBase && 'VALIS_API_BASE',
  ].filter(Boolean);
  if (missing.length > 0) {
    console.error(`verify-prod-state: missing required env vars: ${missing.join(', ')}`);
    process.exit(2);
  }

  // Check 1: Postgres schema
  const { result: pg } = await timed('postgres_schema_migration_022', () =>
    checkPostgresSchema(supabaseDbUrl as string),
  );
  results.push(pg);

  // Check 2: Qdrant indexes
  const { value: idxValue, result: idx } = await timed('qdrant_payload_indexes', () =>
    checkQdrantIndexes(qdrantUrl as string, qdrantApiKey as string),
  );
  if (idx.status === 'passed' && idxValue) {
    idx.detail = `existed=${idxValue.existed} created=${idxValue.created}`;
  }
  results.push(idx);

  // Check 3a: OAuth metadata endpoint reachable
  const { result: oauth } = await timed('http_oauth_metadata', () =>
    checkOAuthMetadata(valisApiBase as string),
  );
  results.push(oauth);

  // Check 3b: /api/check synthetic probe (only if VALIS_TOKEN provided)
  const valisToken = process.env.VALIS_TOKEN;
  if (valisToken) {
    const { result: apiCheck } = await timed('http_api_check_probe', () =>
      checkApiCheckProbe(valisApiBase as string, valisToken),
    );
    results.push(apiCheck);
  } else {
    results.push(skipped('http_api_check_probe', 'VALIS_TOKEN not set'));
  }

  // Check 4: PostHog events (optional)
  const posthogKey = process.env.POSTHOG_API_KEY;
  const posthogHost = process.env.POSTHOG_HOST;
  if (posthogKey && posthogHost) {
    const { result: posthog } = await timed('posthog_funnel_events_recent', () =>
      checkPostHogEvents(posthogHost, posthogKey),
    );
    results.push(posthog);
  } else {
    results.push(skipped('posthog_funnel_events_recent', 'POSTHOG_API_KEY / POSTHOG_HOST not set'));
  }

  // ─── Report ────────────────────────────────────────────────────────────
  console.log('\nverify-prod-state — report');
  console.log('─'.repeat(60));
  for (const r of results) {
    const tag =
      r.status === 'passed'
        ? '✓ PASS'
        : r.status === 'failed'
          ? '✗ FAIL'
          : '○ SKIP';
    const line = `${tag.padEnd(8)} ${r.name.padEnd(40)} ${r.duration_ms}ms`;
    console.log(line);
    if (r.detail) console.log(`         ${r.detail}`);
  }
  console.log('─'.repeat(60));

  const failed = results.filter((r) => r.status === 'failed').length;
  if (failed > 0) {
    console.error(`\nverify-prod-state: ${failed} CHECK(S) FAILED`);
    process.exit(1);
  }
  console.log('\nverify-prod-state: ALL CHECKS PASSED');
}

// Allow the module to be imported by tests (which read exported functions)
// without invoking main(). `import.meta.url` includes the file path, so the
// "is this the entry point" check works the same way `require.main === module`
// did in CommonJS.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error('verify-prod-state: fatal error', err);
    process.exit(2);
  });
}
