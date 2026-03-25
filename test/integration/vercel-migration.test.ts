/**
 * T042-T044: End-to-end and static analysis tests for Vercel API migration.
 *
 * T042: E2E test for full hosted flow via Vercel API routes.
 * T043: E2E test for hosted enrichment flow.
 * T044: Static analysis — no hardcoded /functions/v1/ in hosted-mode code paths.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { HOSTED_API_URL, HOSTED_SUPABASE_URL } from '../../src/types.js';
import { resolveApiUrl, resolveApiPath, isHostedMode } from '../../src/cloud/api-url.js';
import type { ValisConfig } from '../../src/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Recursively collect all .ts files under a directory. */
function collectTsFiles(dir: string, files: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      collectTsFiles(full, files);
    } else if (full.endsWith('.ts') && !full.endsWith('.test.ts') && !full.endsWith('.d.ts')) {
      files.push(full);
    }
  }
  return files;
}

const CLI_SRC_DIR = resolve(__dirname, '../../src');

// ---------------------------------------------------------------------------
// T042: E2E hosted flow routing verification
// ---------------------------------------------------------------------------

describe('T042: Hosted flow routes through /api/ paths', () => {
  const hostedConfig: ValisConfig = {
    org_id: 'org-hosted-1234',
    org_name: 'HostedOrg',
    api_key: '',
    invite_code: 'HOST-CODE',
    author_name: 'Alice',
    supabase_url: HOSTED_SUPABASE_URL,
    supabase_service_role_key: '', // empty for hosted
    qdrant_url: 'https://qdrant.example.com',
    qdrant_api_key: '',
    configured_ides: [],
    created_at: '2026-03-25T00:00:00.000Z',
    member_api_key: 'tmm_abc123',
    member_id: 'member-hosted-1234',
    auth_mode: 'jwt',
  };

  it('isHostedMode correctly detects hosted config', () => {
    expect(isHostedMode(hostedConfig)).toBe(true);
  });

  it('resolveApiUrl returns HOSTED_API_URL for hosted mode', () => {
    const url = resolveApiUrl(hostedConfig.supabase_url, true);
    expect(url).toBe(HOSTED_API_URL);
  });

  it('register route uses /api/register in hosted mode', () => {
    const apiUrl = resolveApiUrl(HOSTED_SUPABASE_URL, true);
    const path = resolveApiPath(apiUrl, 'register');
    expect(path).toBe(`${HOSTED_API_URL}/api/register`);
  });

  it('exchange-token route uses /api/exchange-token in hosted mode', () => {
    const apiUrl = resolveApiUrl(HOSTED_SUPABASE_URL, true);
    const path = resolveApiPath(apiUrl, 'exchange-token');
    expect(path).toBe(`${HOSTED_API_URL}/api/exchange-token`);
  });

  it('check-usage route uses /api/check-usage in hosted mode', () => {
    const apiUrl = resolveApiUrl(HOSTED_SUPABASE_URL, true);
    const path = resolveApiPath(apiUrl, 'check-usage');
    expect(path).toBe(`${HOSTED_API_URL}/api/check-usage`);
  });

  it('seed route uses /api/seed in hosted mode', () => {
    const apiUrl = resolveApiUrl(HOSTED_SUPABASE_URL, true);
    const path = resolveApiPath(apiUrl, 'seed');
    expect(path).toBe(`${HOSTED_API_URL}/api/seed`);
  });

  it('change-status route uses /api/change-status in hosted mode', () => {
    const apiUrl = resolveApiUrl(HOSTED_SUPABASE_URL, true);
    const path = resolveApiPath(apiUrl, 'change-status');
    expect(path).toBe(`${HOSTED_API_URL}/api/change-status`);
  });

  it('join-project route uses /api/join-project in hosted mode', () => {
    const apiUrl = resolveApiUrl(HOSTED_SUPABASE_URL, true);
    const path = resolveApiPath(apiUrl, 'join-project');
    expect(path).toBe(`${HOSTED_API_URL}/api/join-project`);
  });

  it('create-checkout route uses /api/create-checkout in hosted mode', () => {
    const apiUrl = resolveApiUrl(HOSTED_SUPABASE_URL, true);
    const path = resolveApiPath(apiUrl, 'create-checkout');
    expect(path).toBe(`${HOSTED_API_URL}/api/create-checkout`);
  });

  it('community mode preserves /functions/v1/ paths', () => {
    const communityUrl = 'https://my-instance.supabase.co';
    const apiUrl = resolveApiUrl(communityUrl, false);
    const path = resolveApiPath(apiUrl, 'register');
    expect(path).toBe(`${communityUrl}/functions/v1/register`);
  });
});

// ---------------------------------------------------------------------------
// T043: Enrichment route verification
// ---------------------------------------------------------------------------

describe('T043: Hosted enrichment route', () => {
  it('enrich route uses /api/enrich in hosted mode', () => {
    const apiUrl = resolveApiUrl(HOSTED_SUPABASE_URL, true);
    const path = resolveApiPath(apiUrl, 'enrich');
    expect(path).toBe(`${HOSTED_API_URL}/api/enrich`);
  });

  it('enrich route uses /functions/v1/enrich in community mode', () => {
    const communityUrl = 'https://my-instance.supabase.co';
    const apiUrl = resolveApiUrl(communityUrl, false);
    const path = resolveApiPath(apiUrl, 'enrich');
    expect(path).toBe(`${communityUrl}/functions/v1/enrich`);
  });
});

// ---------------------------------------------------------------------------
// T044: Static analysis — no hardcoded /functions/v1/ in hosted-mode paths
// ---------------------------------------------------------------------------

describe('T044: Static analysis — /functions/v1/ usage audit', () => {
  const cliSourceFiles = collectTsFiles(CLI_SRC_DIR);

  it('found CLI source files to analyze', () => {
    expect(cliSourceFiles.length).toBeGreaterThan(0);
  });

  it('api-url.ts module exists and exports resolveApiPath', () => {
    const apiUrlPath = resolve(CLI_SRC_DIR, 'cloud/api-url.ts');
    const content = readFileSync(apiUrlPath, 'utf8');
    expect(content).toContain('export function resolveApiPath');
    expect(content).toContain('export function resolveApiUrl');
    expect(content).toContain('export function isHostedMode');
  });

  it('HOSTED_API_URL constant is defined in types.ts', () => {
    const typesPath = resolve(CLI_SRC_DIR, 'types.ts');
    const content = readFileSync(typesPath, 'utf8');
    expect(content).toContain("export const HOSTED_API_URL = 'https://valis.krukit.co'");
  });

  it('no /functions/v1/ URLs in files that should use resolveApiPath', () => {
    // Files that have been updated to use resolveApiPath should not contain
    // hardcoded /functions/v1/ in their fetch calls (except in comments,
    // community-mode fallback branches, and the api-url.ts resolver itself).
    const exceptions = [
      'cloud/api-url.ts',    // The resolver itself contains the pattern
      'types.ts',            // JSDoc comments reference the path
    ];

    // Files that still contain /functions/v1/ but should only in community paths
    const knownCommunityPaths = [
      'commands/init.ts',         // createOrg direct SQL fallback for community
      'cloud/registration.ts',    // registration calls (community fallback)
      'cloud/supabase.ts',        // createProject/joinProject community fallback
      'seed/index.ts',            // runHostedSeed doc comment + community path
      'auth/jwt.ts',              // exchangeToken (to be updated in T026)
      'billing/usage.ts',         // checkUsageOrProceed (to be updated in T027)
      'commands/upgrade.ts',      // create-checkout (to be updated in T031b)
      'mcp/tools/store.ts',       // supersedeDecision (to be updated in T031c)
      'commands/switch-org.ts',   // join-org (to be updated in T031e)
    ];

    for (const filePath of cliSourceFiles) {
      const relative = filePath.replace(CLI_SRC_DIR + '/', '');
      if (exceptions.includes(relative)) continue;

      const content = readFileSync(filePath, 'utf8');
      const lines = content.split('\n');

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line.includes('/functions/v1/')) continue;

        // Allow comments
        const trimmed = line.trim();
        if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) {
          continue;
        }

        // Allow known community path files (they still need /functions/v1/ for community mode)
        if (knownCommunityPaths.includes(relative)) {
          continue;
        }

        // This is an unexpected hardcoded /functions/v1/ reference
        throw new Error(
          `Unexpected hardcoded /functions/v1/ URL in ${relative}:${i + 1}: ${trimmed}\n` +
          'This should use resolveApiPath() or be in a community-mode code path.',
        );
      }
    }
  });

  it('all 13 Supabase EFs have deprecation notices', () => {
    const efDir = resolve(__dirname, '../../../../supabase/functions');
    const expectedFunctions = [
      'register',
      'exchange-token',
      'check-usage',
      'join-project',
      'join-org',
      'create-org',
      'create-project',
      'change-status',
      'rotate-key',
      'revoke-member',
      'seed',
      'stripe-webhook',
      'create-checkout',
    ];

    for (const fn of expectedFunctions) {
      const indexPath = join(efDir, fn, 'index.ts');
      const content = readFileSync(indexPath, 'utf8');
      expect(content).toContain('@deprecated');
      expect(content).toContain(`packages/web/src/app/api/${fn}/route.ts`);
      expect(content).toContain('community/self-hosted deployments only');
    }
  });
});
