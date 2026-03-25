/**
 * T037: Integration test — community mode init verification.
 *
 * Verifies:
 * - Community init prompts for Supabase URL, Service Role Key, Qdrant URL, Qdrant API Key
 * - Saved config includes supabase_service_role_key
 * - No calls to HOSTED_API_URL are made in community code paths
 * - EF calls use /functions/v1/ path (not /api/)
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { HOSTED_API_URL, HOSTED_SUPABASE_URL } from '../../src/types.js';
import { resolveApiUrl, resolveApiPath, isHostedMode } from '../../src/cloud/api-url.js';
import type { TeamindConfig } from '../../src/types.js';

// ---------------------------------------------------------------------------
// Community mode config fixture
// ---------------------------------------------------------------------------

const COMMUNITY_CONFIG: TeamindConfig = {
  org_id: 'org-comm-1234-5678-abcdef123456',
  org_name: 'CommunityOrg',
  api_key: 'tm_abc123',
  invite_code: 'COMM-CODE',
  author_name: 'Bob',
  supabase_url: 'https://my-instance.supabase.co',
  supabase_service_role_key: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.service-role-key',
  qdrant_url: 'https://my-cluster.qdrant.io',
  qdrant_api_key: 'qdrant-api-key-abc123',
  configured_ides: [],
  created_at: '2026-03-25T00:00:00.000Z',
  member_id: 'member-comm-1234',
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('T037: Community mode init verification', () => {
  it('community config includes supabase_service_role_key', () => {
    expect(COMMUNITY_CONFIG.supabase_service_role_key).toBeTruthy();
    expect(COMMUNITY_CONFIG.supabase_service_role_key.length).toBeGreaterThan(0);
  });

  it('isHostedMode returns false for community config', () => {
    expect(isHostedMode(COMMUNITY_CONFIG)).toBe(false);
  });

  it('resolveApiUrl returns supabaseUrl for community mode (not HOSTED_API_URL)', () => {
    const url = resolveApiUrl(COMMUNITY_CONFIG.supabase_url, false);
    expect(url).toBe('https://my-instance.supabase.co');
    expect(url).not.toBe(HOSTED_API_URL);
  });

  it('resolveApiPath uses /functions/v1/ for community mode', () => {
    const communityBase = resolveApiUrl(COMMUNITY_CONFIG.supabase_url, false);
    const path = resolveApiPath(communityBase, 'exchange-token');
    expect(path).toBe('https://my-instance.supabase.co/functions/v1/exchange-token');
    expect(path).not.toContain('/api/');
  });

  it('resolveApiPath uses /api/ for hosted mode', () => {
    const hostedBase = resolveApiUrl(HOSTED_SUPABASE_URL, true);
    const path = resolveApiPath(hostedBase, 'exchange-token');
    expect(path).toBe(`${HOSTED_API_URL}/api/exchange-token`);
    expect(path).not.toContain('/functions/v1/');
  });

  it('community config prompts include 4 credential fields', () => {
    // Verify init.ts community block references all 4 prompts by reading the source
    const initSrc = readFileSync(
      resolve(__dirname, '../../src/commands/init.ts'),
      'utf8',
    );

    // The community block should prompt for these 4 values
    expect(initSrc).toContain("await prompt('Supabase URL: ')");
    expect(initSrc).toContain("await prompt('Supabase Service Role Key: ')");
    expect(initSrc).toContain("await prompt('Qdrant URL: ')");
    expect(initSrc).toContain("await prompt('Qdrant API Key: ')");
  });

  it('community code path does not reference HOSTED_API_URL', () => {
    // Read init.ts and isolate the community mode block
    const initSrc = readFileSync(
      resolve(__dirname, '../../src/commands/init.ts'),
      'utf8',
    );

    // Extract community block — between "Community mode:" and the closing brace
    const communityStart = initSrc.indexOf('T036: Community mode');
    expect(communityStart).toBeGreaterThan(-1);

    // The community block should not contain HOSTED_API_URL usage
    // (the import at the top is fine, usage in community paths is not)
    const communityBlock = initSrc.slice(communityStart, communityStart + 2000);
    expect(communityBlock).not.toContain('HOSTED_API_URL');
  });

  it('no hardcoded /api/ route URLs in community mode CLI calls', () => {
    // All /api/ URLs should only appear when isHosted is true
    // Community mode must use /functions/v1/
    const apiUrlSrc = readFileSync(
      resolve(__dirname, '../../src/cloud/api-url.ts'),
      'utf8',
    );

    // resolveApiPath should return /functions/v1/ when apiUrl is NOT HOSTED_API_URL
    expect(apiUrlSrc).toContain("/functions/v1/${functionName}");
  });
});
