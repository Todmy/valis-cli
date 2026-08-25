/**
 * Tests for the E2E production guard and created-org manifest (gh#318).
 *
 * Lives outside `test/e2e/` on purpose: everything in that directory is gated
 * behind `canRunE2E()` and skips in normal runs, but the guard is the one piece
 * that must be verified on every single run — it is what makes a repeat of the
 * 30-leaked-org incident impossible.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertNotProduction,
  isProductionSupabase,
  isProductionApi,
  hostOf,
  PRODUCTION_SUPABASE_HOSTS,
} from './e2e/prod-guard.js';

describe('prod-guard: host detection', () => {
  it('recognises the production Supabase project', () => {
    expect(isProductionSupabase('https://rmawxpdaudinbansjfpd.supabase.co')).toBe(true);
    expect(isProductionSupabase('https://rmawxpdaudinbansjfpd.supabase.co/')).toBe(true);
    expect(isProductionSupabase('https://RMAWXPDAUDINBANSJFPD.supabase.co')).toBe(true);
  });

  it('does not flag other Supabase projects or a local stack', () => {
    expect(isProductionSupabase('https://someotherproject.supabase.co')).toBe(false);
    expect(isProductionSupabase('http://localhost:54321')).toBe(false);
    expect(isProductionSupabase('http://127.0.0.1:54321')).toBe(false);
  });

  it('recognises the production API deployment', () => {
    expect(isProductionApi('https://valis.krukit.co')).toBe(true);
    expect(isProductionApi('https://valis.krukit.co/api')).toBe(true);
    expect(isProductionApi('http://localhost:3000')).toBe(false);
  });

  it('returns null for unparseable URLs instead of throwing', () => {
    expect(hostOf('not a url')).toBeNull();
    expect(isProductionSupabase('not a url')).toBe(false);
  });
});

describe('prod-guard: assertNotProduction', () => {
  it('throws when the Supabase URL is production', () => {
    expect(() =>
      assertNotProduction('https://rmawxpdaudinbansjfpd.supabase.co', 'http://localhost:3000'),
    ).toThrow(/REFUSES TO RUN AGAINST PRODUCTION/);
  });

  it('throws when the API URL is production', () => {
    expect(() =>
      assertNotProduction('http://localhost:54321', 'https://valis.krukit.co'),
    ).toThrow(/REFUSES TO RUN AGAINST PRODUCTION/);
  });

  it('names the offending variable in the message', () => {
    expect(() =>
      assertNotProduction('https://rmawxpdaudinbansjfpd.supabase.co', ''),
    ).toThrow(/VALIS_E2E_SUPABASE_URL/);
  });

  it('is a no-op when both URLs are non-production', () => {
    expect(() =>
      assertNotProduction('http://localhost:54321', 'http://localhost:3000'),
    ).not.toThrow();
  });

  it('is a no-op when unset — the ordinary "suite skipped" state', () => {
    expect(() => assertNotProduction('', '')).not.toThrow();
  });

  it('has no override flag: env vars cannot re-enable a production run', () => {
    const before = { ...process.env };
    process.env.VALIS_E2E_ALLOW_PRODUCTION = '1';
    process.env.CI = 'true';
    try {
      expect(() =>
        assertNotProduction('https://rmawxpdaudinbansjfpd.supabase.co', ''),
      ).toThrow(/REFUSES/);
    } finally {
      process.env = before;
    }
  });

  it('pins the production host as a literal, immune to VALIS_SUPABASE_URL', () => {
    // The guard must not read HOSTED_SUPABASE_URL, which is env-overridable:
    // a stray VALIS_SUPABASE_URL would otherwise move the guard off production.
    expect(PRODUCTION_SUPABASE_HOSTS).toContain('rmawxpdaudinbansjfpd.supabase.co');
  });
});

describe('e2e cleanup: created-org manifest', () => {
  let dir: string;
  let manifest: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'valis-manifest-'));
    manifest = join(dir, 'created-orgs.jsonl');
    vi.resetModules();
    process.env.VALIS_E2E_MANIFEST = manifest;
  });

  afterEach(async () => {
    delete process.env.VALIS_E2E_MANIFEST;
    await rm(dir, { recursive: true, force: true });
  });

  async function loadCleanup() {
    return import('./e2e/cleanup.js');
  }

  it('reads an absent manifest as empty', async () => {
    const { readManifest } = await loadCleanup();
    expect(await readManifest()).toEqual([]);
  });

  it('records an org the moment it is created', async () => {
    const { trackCreatedOrg, readManifest } = await loadCleanup();
    await trackCreatedOrg({
      org_id: 'org-1',
      org_name: 'e2e-test-init-abcd',
      created_at: '2026-08-16T10:00:00.000Z',
    });
    const entries = await readManifest();
    expect(entries).toHaveLength(1);
    expect(entries[0].org_id).toBe('org-1');
    // Written to disk immediately, so a SIGKILL still leaves the trace.
    expect(await readFile(manifest, 'utf-8')).toContain('org-1');
  });

  it('survives a torn final line from a killed process', async () => {
    await writeFile(
      manifest,
      '{"org_id":"org-1","org_name":"a","created_at":"x"}\n{"org_id":"org-2","org_na',
      'utf-8',
    );
    const { readManifest } = await loadCleanup();
    const entries = await readManifest();
    expect(entries.map((e) => e.org_id)).toEqual(['org-1']);
  });

  it('teardown with an empty manifest is a silent no-op', async () => {
    const { teardownCreatedOrgs } = await loadCleanup();
    const result = await teardownCreatedOrgs();
    expect(result).toMatchObject({ attempted: 0, deleted: 0, skippedReason: 'nothing-to-do' });
  });

  it('teardown without admin creds warns and keeps the entries for the sweep', async () => {
    const { trackCreatedOrg, teardownCreatedOrgs, readManifest } = await loadCleanup();
    const saved = {
      key: process.env.VALIS_E2E_SUPABASE_SERVICE_ROLE_KEY,
      qurl: process.env.VALIS_E2E_QDRANT_URL,
      qkey: process.env.VALIS_E2E_QDRANT_API_KEY,
    };
    delete process.env.VALIS_E2E_SUPABASE_SERVICE_ROLE_KEY;
    delete process.env.VALIS_E2E_QDRANT_URL;
    delete process.env.VALIS_E2E_QDRANT_API_KEY;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      await trackCreatedOrg({
        org_id: 'org-1',
        org_name: 'e2e-test-init-abcd',
        created_at: '2026-08-16T10:00:00.000Z',
      });
      const result = await teardownCreatedOrgs();
      expect(result.skippedReason).toBe('no-credentials');
      expect(warn).toHaveBeenCalled();
      // Entry survives so scripts/e2e-sweep.mjs still has a record of the leak.
      expect(await readManifest()).toHaveLength(1);
    } finally {
      warn.mockRestore();
      if (saved.key) process.env.VALIS_E2E_SUPABASE_SERVICE_ROLE_KEY = saved.key;
      if (saved.qurl) process.env.VALIS_E2E_QDRANT_URL = saved.qurl;
      if (saved.qkey) process.env.VALIS_E2E_QDRANT_API_KEY = saved.qkey;
    }
  });

  it('writeManifest truncates to the entries still needing cleanup', async () => {
    const { trackCreatedOrg, writeManifest, readManifest } = await loadCleanup();
    await trackCreatedOrg({ org_id: 'a', org_name: 'e2e-test-a', created_at: 'x' });
    await trackCreatedOrg({ org_id: 'b', org_name: 'e2e-test-b', created_at: 'x' });
    await writeManifest([]);
    expect(await readManifest()).toEqual([]);
  });
});
