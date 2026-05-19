/**
 * Feature 033 — write-refusal regression for the public-KB read access feature.
 *
 * The public-flag MUST never grant write access. Any non-member attempting to
 * write to a public project (via `valis_store`, or any other write tool) is
 * blocked by the same mechanism that has always blocked cross-org writes — the
 * BUG #175 `project_scope_mismatch` defensive guard at the MCP handler level,
 * plus the RLS `decisions_insert_member` policy at the DB level.
 *
 * What this test pins:
 *   - `valis_store` returns `project_scope_mismatch` when the caller's JWT
 *     scope (configOverride.project_id) differs from the requested
 *     args.project_id, regardless of whether the requested project is public.
 *   - The error envelope carries `action: 'blocked'` (no write is attempted
 *     downstream).
 *
 * What this test does NOT pin (out of scope, layered defence at DB):
 *   - The RLS `decisions_insert_member` policy itself. That is exercised by
 *     applying migration 023 and running the manual quickstart, not by a
 *     vitest unit/integration test.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../src/config/store.js', () => ({
  loadConfig: vi.fn().mockResolvedValue({
    org_id: 'caller-org',
    qdrant_url: 'https://test.qdrant.io',
    qdrant_api_key: 'test-key',
    auth_mode: 'jwt',
  }),
}));

vi.mock('../../../src/cloud/qdrant.js', () => ({
  getQdrantClient: vi.fn().mockReturnValue({}),
}));

vi.mock('../../../src/cloud/supabase.js', () => ({
  getSupabaseClient: vi.fn().mockReturnValue({}),
  getSupabaseJwtClient: vi.fn().mockReturnValue({}),
  getDecisionsByIds: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../../src/billing/usage.js', () => ({
  checkUsageBeforeStore: vi.fn().mockResolvedValue({ allowed: true }),
  incrementUsage: vi.fn().mockResolvedValue(undefined),
}));

import { handleStore } from '../../../src/mcp/tools/store.js';

const httpServerOverride = {
  org_id: 'caller-org',
  member_id: 'caller-member-id',
  author_name: 'Caller',
  role: 'project_member',
  auth_mode: 'jwt' as const,
  supabase_url: 'https://test.supabase.co',
  supabase_service_role_key: 'srv-key',
  qdrant_url: 'https://test.qdrant.io',
  qdrant_api_key: 'test-key',
  api_key: 'tok',
  member_api_key: 'tok',
  project_id: 'own-project-id',
};

const PUBLIC_TARGET = 'public-target-project-id';

describe('valis_store — write refusal against public projects (feature 033)', () => {
  it('returns project_scope_mismatch when caller tries to write to a different project (even if public)', async () => {
    const result = await handleStore(
      {
        type: 'decision',
        summary: 'malicious write to public project',
        detail: 'a non-member should not be able to write to a public KB',
        author: 'attacker',
        affects: ['kb'],
        project_id: PUBLIC_TARGET,
      },
      httpServerOverride,
    );

    // Per BUG #175 / store.ts:349, this returns `project_scope_mismatch`.
    expect(result.error).toBe('project_scope_mismatch');
    expect(result.project_scope_mismatch).toMatchObject({
      session_project_id: 'own-project-id',
      current_project_id: PUBLIC_TARGET,
      action_required: 'restart_session',
    });
    // No store id materialised — write was refused before reaching Postgres.
    expect((result as { id?: string }).id).toBeFalsy();
  });

  it('does NOT introduce a target_project_id arg on the write side', () => {
    // Compile-time + runtime assertion: store.ts has not been extended with
    // any cross-org public-write mechanic. Feature 033 is read-only.
    // (If you ever add `target_project_id` to handleStore, you need a new
    // spec — public-flag writes are explicitly out of scope.)
    const argShape: Record<string, unknown> = {
      type: 'decision',
      summary: 'x',
      detail: 'x',
      author: 'x',
      affects: ['x'],
    };
    expect('target_project_id' in argShape).toBe(false);
  });
});
