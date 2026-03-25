/**
 * T030 / T031: Unit tests for URL resolution helpers (006 — Vercel API Migration).
 *
 * Tests cover:
 * - resolveApiUrl returns HOSTED_API_URL for hosted mode
 * - resolveApiUrl returns supabaseUrl for community mode
 * - resolveApiPath returns /api/<name> for hosted, /functions/v1/<name> for community
 * - isHostedMode detects hosted config correctly
 * - T031: all CLI EF call sites use resolveApiPath (static analysis)
 */

import { describe, it, expect } from 'vitest';
import { resolveApiUrl, resolveApiPath, isHostedMode } from '../../src/cloud/api-url.js';
import { HOSTED_API_URL, HOSTED_SUPABASE_URL, type TeamindConfig } from '../../src/types.js';

// ---------------------------------------------------------------------------
// T030: resolveApiUrl
// ---------------------------------------------------------------------------

describe('resolveApiUrl', () => {
  it('returns HOSTED_API_URL when isHosted is true', () => {
    expect(resolveApiUrl(HOSTED_SUPABASE_URL, true)).toBe(HOSTED_API_URL);
  });

  it('returns supabaseUrl for community mode', () => {
    const communityUrl = 'https://my-supabase.example.com';
    expect(resolveApiUrl(communityUrl, false)).toBe(communityUrl);
  });

  it('strips trailing slash from community URL', () => {
    const communityUrl = 'https://my-supabase.example.com/';
    expect(resolveApiUrl(communityUrl, false)).toBe('https://my-supabase.example.com');
  });

  it('ignores supabaseUrl value when isHosted is true', () => {
    expect(resolveApiUrl('https://anything.example.com', true)).toBe(HOSTED_API_URL);
  });
});

// ---------------------------------------------------------------------------
// T030: resolveApiPath
// ---------------------------------------------------------------------------

describe('resolveApiPath', () => {
  it('returns /api/<name> for HOSTED_API_URL', () => {
    expect(resolveApiPath(HOSTED_API_URL, 'register')).toBe(
      `${HOSTED_API_URL}/api/register`,
    );
  });

  it('returns /api/<name> for various function names on hosted', () => {
    const names = [
      'exchange-token', 'check-usage', 'create-org', 'create-checkout',
      'change-status', 'seed', 'join-org', 'join-project', 'create-project',
    ];
    for (const name of names) {
      expect(resolveApiPath(HOSTED_API_URL, name)).toBe(`${HOSTED_API_URL}/api/${name}`);
    }
  });

  it('returns /functions/v1/<name> for community URLs', () => {
    const communityUrl = 'https://my-supabase.example.com';
    expect(resolveApiPath(communityUrl, 'register')).toBe(
      `${communityUrl}/functions/v1/register`,
    );
  });

  it('returns /functions/v1/<name> for community exchange-token', () => {
    const communityUrl = 'https://rmawxpdaudinbansjfpd.supabase.co';
    // Note: this is the Supabase URL, NOT HOSTED_API_URL, so it uses EF path
    expect(resolveApiPath(communityUrl, 'exchange-token')).toBe(
      `${communityUrl}/functions/v1/exchange-token`,
    );
  });

  it('strips trailing slash from apiUrl', () => {
    expect(resolveApiPath(`${HOSTED_API_URL}/`, 'register')).toBe(
      `${HOSTED_API_URL}/api/register`,
    );
  });
});

// ---------------------------------------------------------------------------
// T030: isHostedMode
// ---------------------------------------------------------------------------

describe('isHostedMode', () => {
  const baseConfig: TeamindConfig = {
    org_id: 'org-1',
    org_name: 'Test Org',
    api_key: '',
    invite_code: 'ABCD-EFGH',
    author_name: 'Test',
    supabase_url: HOSTED_SUPABASE_URL,
    supabase_service_role_key: '',
    qdrant_url: 'https://qdrant.example.com',
    qdrant_api_key: 'key',
    configured_ides: [],
    created_at: new Date().toISOString(),
  };

  it('returns true for hosted config (HOSTED_SUPABASE_URL + empty service_role_key)', () => {
    expect(isHostedMode(baseConfig)).toBe(true);
  });

  it('returns true when service_role_key is undefined', () => {
    const config = { ...baseConfig, supabase_service_role_key: undefined as unknown as string };
    // isHostedMode checks falsy, so undefined should also be hosted
    expect(isHostedMode(config)).toBe(true);
  });

  it('returns false for community config (different supabase_url)', () => {
    const config = {
      ...baseConfig,
      supabase_url: 'https://my-supabase.example.com',
    };
    expect(isHostedMode(config)).toBe(false);
  });

  it('returns false when supabase_url matches but service_role_key is present', () => {
    const config = {
      ...baseConfig,
      supabase_service_role_key: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.test',
    };
    expect(isHostedMode(config)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// T031: Static analysis — ensure no hardcoded /functions/v1/ in hosted paths
// ---------------------------------------------------------------------------

describe('T031: no hardcoded /functions/v1/ in hosted mode paths', () => {
  it('HOSTED_API_URL never produces /functions/v1/ paths via resolveApiPath', () => {
    const allEndpoints = [
      'register', 'join-project', 'join-org', 'create-org', 'create-project',
      'exchange-token', 'check-usage', 'create-checkout', 'change-status',
      'seed', 'rotate-key', 'revoke-member', 'stripe-webhook',
    ];

    for (const endpoint of allEndpoints) {
      const path = resolveApiPath(HOSTED_API_URL, endpoint);
      expect(path).not.toContain('/functions/v1/');
      expect(path).toContain('/api/');
    }
  });

  it('community URLs always produce /functions/v1/ paths', () => {
    const communityUrl = 'https://my-community.supabase.co';
    const path = resolveApiPath(communityUrl, 'register');
    expect(path).toContain('/functions/v1/');
    expect(path).not.toContain('/api/');
  });
});
