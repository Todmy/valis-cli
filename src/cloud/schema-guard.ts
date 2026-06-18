/**
 * Self-host schema version-guard (#299).
 *
 * Community / self-hosted Valis applies the SQL schema from a co-located
 * `community/migrations/` mirror via the one-shot `migrate` docker service,
 * recording each applied file in the public `valis_schema_migrations` ledger.
 * The CLI's expected schema version is baked at build time into
 * `REQUIRED_SCHEMA_MIGRATION` (generated from the MAX migration filename — see
 * scripts/gen-schema-version.mjs).
 *
 * This guard runs in **Community mode only** (Hosted skips — the server owns
 * the schema). It reads the max applied migration number from the ledger and
 * compares:
 *
 *   - DB BEHIND (max < required)  → THROW (block the write). The self-hoster
 *     must `git pull && docker compose up -d` to apply the new migrations.
 *   - DB AHEAD  (max > required)  → WARN (non-fatal). The CLI is older than the
 *     self-host schema; suggest `npm i -g valis-cli@latest`. Continue.
 *   - equal                       → silent.
 *
 * Cost discipline: one cheap query, cached for the process lifetime.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { isHostedMode } from './api-url.js';
import { getSupabaseClient } from './supabase/client.js';
import { REQUIRED_SCHEMA_MIGRATION } from '../generated/schema-version.js';
import type { ValisConfig } from '../types.js';

export class SchemaOutOfDateError extends Error {
  readonly code = 'schema_out_of_date';
  constructor(
    readonly dbVersion: number,
    readonly requiredVersion: number,
  ) {
    super(
      `Self-host schema out of date (DB at ${dbVersion}, this CLI needs ${requiredVersion}). ` +
        'Update it: cd <valis-cli>/community && git pull && docker compose up -d',
    );
    this.name = 'SchemaOutOfDateError';
  }
}

/**
 * Read the max applied migration number from the `valis_schema_migrations`
 * ledger. Filenames are `NNN_*.sql`; we parse the leading numeric prefix and
 * return the highest. Returns 0 when the ledger is empty / unreadable so the
 * caller treats it as "behind".
 */
export async function readMaxAppliedMigration(
  supabase: SupabaseClient,
): Promise<number> {
  const { data, error } = await supabase
    .from('valis_schema_migrations')
    .select('filename');
  if (error) {
    throw new Error(
      `Could not read self-host schema ledger (valis_schema_migrations): ${error.message}`,
    );
  }
  let max = 0;
  for (const row of (data ?? []) as Array<{ filename: string }>) {
    const m = /^(\d+)/.exec(row.filename);
    if (!m) continue;
    const n = Number.parseInt(m[1], 10);
    if (n > max) max = n;
  }
  return max;
}

// Process-level cache — the guard runs at most once per process (init / serve
// startup); subsequent calls short-circuit.
let cachedResult: 'ok' | null = null;

export function resetSchemaGuardCache(): void {
  cachedResult = null;
}

/**
 * Run the Community-mode schema version-guard.
 *
 * No-op (and silent) in Hosted mode. In Community mode, queries the ledger and:
 *   - throws {@link SchemaOutOfDateError} when the DB is behind the CLI;
 *   - prints a warning when the DB is ahead;
 *   - is silent when equal.
 *
 * @param config       resolved ValisConfig (Community mode has a service_role_key)
 * @param supabaseArg  optional client override (tests inject a mock)
 * @param warn         warning sink (defaults to console.warn) — testable
 */
export async function assertSchemaCompatible(
  config: ValisConfig,
  supabaseArg?: SupabaseClient,
  warn: (msg: string) => void = (m) => console.warn(m),
): Promise<void> {
  // Hosted mode: the server owns the schema — never guard here.
  if (isHostedMode(config)) return;
  // Defensive: a non-hosted config without a service-role key cannot reach the
  // ledger directly (e.g. a malformed config). Skip rather than crash.
  if (!config.supabase_service_role_key) return;

  if (cachedResult === 'ok') return;

  const supabase =
    supabaseArg ??
    getSupabaseClient(config.supabase_url, config.supabase_service_role_key);

  const dbVersion = await readMaxAppliedMigration(supabase);
  const required = REQUIRED_SCHEMA_MIGRATION;

  if (dbVersion < required) {
    throw new SchemaOutOfDateError(dbVersion, required);
  }
  if (dbVersion > required) {
    warn(
      `⚠ Self-host schema (${dbVersion}) is newer than this CLI (${required}). ` +
        'Update the CLI: npm i -g valis-cli@latest',
    );
  }
  // equal → silent
  cachedResult = 'ok';
}
