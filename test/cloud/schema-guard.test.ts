/**
 * #299 — Unit tests for the Community self-host schema version-guard.
 *
 * Covers the three branches against a mocked `valis_schema_migrations` ledger
 * query, plus the Hosted-mode skip:
 *   - DB BEHIND (max applied < required) → throws SchemaOutOfDateError (blocks)
 *   - DB AHEAD  (max applied > required) → warns, does not throw
 *   - equal                             → silent, no throw, no warn
 *   - Hosted mode                        → guard is a no-op (server owns schema)
 *
 * The required version is the build-time generated REQUIRED_SCHEMA_MIGRATION.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  assertSchemaCompatible,
  readMaxAppliedMigration,
  resetSchemaGuardCache,
  SchemaOutOfDateError,
} from '../../src/cloud/schema-guard.js';
import { REQUIRED_SCHEMA_MIGRATION } from '../../src/generated/schema-version.js';
import { HOSTED_SUPABASE_URL, type ValisConfig } from '../../src/types.js';

/**
 * Build a stub SupabaseClient whose
 * `.from('valis_schema_migrations').select('filename')` resolves to a ledger of
 * filenames covering migrations 1..maxApplied (NNN_x.sql).
 */
function mockLedgerClient(maxApplied: number): SupabaseClient {
  const data = Array.from({ length: maxApplied }, (_, i) => ({
    filename: `${String(i + 1).padStart(3, '0')}_m.sql`,
  }));
  return {
    from: () => ({
      select: () => Promise.resolve({ data, error: null }),
    }),
  } as unknown as SupabaseClient;
}

function mockErrorClient(message: string): SupabaseClient {
  return {
    from: () => ({
      select: () => Promise.resolve({ data: null, error: { message } }),
    }),
  } as unknown as SupabaseClient;
}

const communityConfig = {
  supabase_url: 'http://localhost:8000',
  supabase_service_role_key: 'service-role-jwt',
} as ValisConfig;

beforeEach(() => {
  resetSchemaGuardCache();
});

describe('readMaxAppliedMigration', () => {
  it('parses the max numeric prefix from the ledger', async () => {
    const max = await readMaxAppliedMigration(mockLedgerClient(12));
    expect(max).toBe(12);
  });

  it('returns 0 for an empty ledger', async () => {
    const max = await readMaxAppliedMigration(mockLedgerClient(0));
    expect(max).toBe(0);
  });

  it('throws when the ledger query errors', async () => {
    await expect(
      readMaxAppliedMigration(mockErrorClient('relation does not exist')),
    ).rejects.toThrow(/valis_schema_migrations/);
  });
});

describe('assertSchemaCompatible — Community mode', () => {
  it('BEHIND: throws SchemaOutOfDateError (blocks the write)', async () => {
    const behind = REQUIRED_SCHEMA_MIGRATION - 1;
    const warn = vi.fn();
    await expect(
      assertSchemaCompatible(communityConfig, mockLedgerClient(behind), warn),
    ).rejects.toBeInstanceOf(SchemaOutOfDateError);
    expect(warn).not.toHaveBeenCalled();

    // Error message carries both versions + the docker-update fix.
    let err: SchemaOutOfDateError | undefined;
    try {
      await assertSchemaCompatible(communityConfig, mockLedgerClient(behind), warn);
    } catch (e) {
      err = e as SchemaOutOfDateError;
    }
    expect(err?.dbVersion).toBe(behind);
    expect(err?.requiredVersion).toBe(REQUIRED_SCHEMA_MIGRATION);
    expect(err?.message).toContain(`DB at ${behind}`);
    expect(err?.message).toContain(`needs ${REQUIRED_SCHEMA_MIGRATION}`);
    expect(err?.message).toContain('docker compose up -d');
  });

  it('AHEAD: warns (non-fatal), does not throw', async () => {
    const ahead = REQUIRED_SCHEMA_MIGRATION + 3;
    const warn = vi.fn();
    await expect(
      assertSchemaCompatible(communityConfig, mockLedgerClient(ahead), warn),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    const msg = warn.mock.calls[0][0] as string;
    expect(msg).toContain(`(${ahead})`);
    expect(msg).toContain(`(${REQUIRED_SCHEMA_MIGRATION})`);
    expect(msg).toContain('npm i -g valis-cli@latest');
  });

  it('EQUAL: silent — no throw, no warn', async () => {
    const warn = vi.fn();
    await expect(
      assertSchemaCompatible(
        communityConfig,
        mockLedgerClient(REQUIRED_SCHEMA_MIGRATION),
        warn,
      ),
    ).resolves.toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('assertSchemaCompatible — Hosted mode', () => {
  it('is a no-op (server owns the schema) — never queries the ledger', async () => {
    const hostedConfig = {
      supabase_url: HOSTED_SUPABASE_URL,
      supabase_service_role_key: '',
    } as ValisConfig;
    const warn = vi.fn();
    // A client that would throw if queried — proves the guard never touches it.
    const exploding = {
      from: () => {
        throw new Error('ledger must not be queried in hosted mode');
      },
    } as unknown as SupabaseClient;
    await expect(
      assertSchemaCompatible(hostedConfig, exploding, warn),
    ).resolves.toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });
});
