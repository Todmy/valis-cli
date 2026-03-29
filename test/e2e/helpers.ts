/**
 * E2E test helpers for VALIS quickstart flow.
 *
 * These tests require a real Supabase + Qdrant backend.
 * Set environment variables before running:
 *   VALIS_E2E_API_URL   — Vercel API URL (e.g. https://valis.krukit.co)
 *   VALIS_E2E_SUPABASE_URL — Supabase project URL
 *
 * Skip all E2E tests when env vars are missing:
 *   pnpm test -- --grep e2e
 */

import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import type { ValisConfig, ProjectConfig, RegistrationResponse } from '../../src/types.js';

// ---------------------------------------------------------------------------
// Environment detection
// ---------------------------------------------------------------------------

export const E2E_API_URL = process.env.VALIS_E2E_API_URL ?? '';
export const E2E_SUPABASE_URL = process.env.VALIS_E2E_SUPABASE_URL ?? '';

/** Returns true when E2E env vars are configured. */
export function canRunE2E(): boolean {
  return !!(E2E_API_URL && E2E_SUPABASE_URL);
}

/** Unique suffix for this test run — prevents collisions across parallel runs. */
export const TEST_RUN_ID = randomUUID().slice(0, 8);

// ---------------------------------------------------------------------------
// Registration helper — calls /api/register directly
// ---------------------------------------------------------------------------

export interface E2ERegistration {
  response: RegistrationResponse;
  config: ValisConfig;
  projectConfig: ProjectConfig;
}

/**
 * Register a fresh org + project via the public /api/register endpoint.
 * Returns the parsed response plus pre-built config objects.
 */
export async function registerTestOrg(
  orgSuffix: string,
  projectName?: string,
): Promise<E2ERegistration> {
  const orgName = `e2e-test-${orgSuffix}-${TEST_RUN_ID}`;
  const projName = projectName ?? `e2e-project-${orgSuffix}`;
  const authorName = `e2e-author-${TEST_RUN_ID}`;

  const res = await fetch(`${E2E_API_URL}/api/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      org_name: orgName,
      project_name: projName,
      author_name: authorName,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(
      `E2E registration failed (HTTP ${res.status}): ${body}`,
    );
  }

  const response = (await res.json()) as RegistrationResponse;

  const config: ValisConfig = {
    org_id: response.org_id,
    org_name: response.org_name,
    api_key: '',
    invite_code: response.invite_code,
    author_name: authorName,
    supabase_url: response.supabase_url,
    supabase_service_role_key: '',
    qdrant_url: response.qdrant_url,
    qdrant_api_key: '',
    configured_ides: [],
    created_at: new Date().toISOString(),
    auth_mode: 'jwt',
    member_api_key: response.member_api_key,
    member_id: response.member_id,
    project_id: response.project_id,
    project_name: projName,
  };

  const projectConfig: ProjectConfig = {
    project_id: response.project_id,
    project_name: projName,
  };

  return { response, config, projectConfig };
}

// ---------------------------------------------------------------------------
// Config file helpers — write/restore ~/.valis/config.json
// ---------------------------------------------------------------------------

const VALIS_CONFIG_DIR = join(homedir(), '.valis');
const VALIS_CONFIG_FILE = join(VALIS_CONFIG_DIR, 'config.json');

let originalConfig: string | null = null;

/** Back up the existing ~/.valis/config.json so we can restore it after tests. */
export async function backupGlobalConfig(): Promise<void> {
  try {
    originalConfig = await readFile(VALIS_CONFIG_FILE, 'utf-8');
  } catch {
    originalConfig = null; // no existing config
  }
}

/** Restore the original ~/.valis/config.json. */
export async function restoreGlobalConfig(): Promise<void> {
  if (originalConfig !== null) {
    await mkdir(VALIS_CONFIG_DIR, { recursive: true });
    await writeFile(VALIS_CONFIG_FILE, originalConfig, { mode: 0o600 });
  } else {
    // Remove the config we created during tests
    try {
      await rm(VALIS_CONFIG_FILE, { force: true });
    } catch {
      // ignore — file may not exist
    }
  }
}

/** Write a ValisConfig to ~/.valis/config.json. */
export async function writeGlobalConfig(config: ValisConfig): Promise<void> {
  await mkdir(VALIS_CONFIG_DIR, { recursive: true, mode: 0o700 });
  await writeFile(VALIS_CONFIG_FILE, JSON.stringify(config, null, 2), {
    mode: 0o600,
  });
}

// ---------------------------------------------------------------------------
// Temp directory helper
// ---------------------------------------------------------------------------

export async function makeTmpDir(prefix = 'valis-e2e-'): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

export async function cleanTmpDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Project config helper
// ---------------------------------------------------------------------------

export async function writeTestProjectConfig(
  dir: string,
  config: ProjectConfig,
): Promise<void> {
  await writeFile(join(dir, '.valis.json'), JSON.stringify(config, null, 2) + '\n', 'utf-8');
}

// ---------------------------------------------------------------------------
// API call helpers — thin wrappers for direct API calls
// ---------------------------------------------------------------------------

/**
 * Exchange a member API key for a JWT token.
 *
 * In hosted mode, the exchange-token endpoint lives at the Vercel API URL
 * (`/api/exchange-token`), not at Supabase Edge Functions.
 */
export async function getJwtToken(
  _supabaseUrl: string,
  memberApiKey: string,
  projectId?: string,
): Promise<{ token: string; expires_at: string; member_id: string }> {
  const body: Record<string, string> = {};
  if (projectId) body.project_id = projectId;

  const res = await fetch(`${E2E_API_URL}/api/exchange-token`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${memberApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`exchange-token failed (${res.status}): ${text}`);
  }

  return res.json() as Promise<{ token: string; expires_at: string; member_id: string }>;
}

/**
 * Store decisions via the /api/seed endpoint.
 *
 * The hosted backend has no /api/store route — the CLI does store operations
 * directly via the Supabase JWT client. For E2E tests we use the /api/seed
 * endpoint which accepts an array of decisions and performs dual-write
 * (Postgres + Qdrant) server-side.
 *
 * Auth: Bearer token using the member_api_key (tmm_...) directly.
 */
export async function apiStore(
  apiUrl: string,
  memberApiKey: string,
  args: {
    text: string;
    type?: string;
    summary?: string;
    affects?: string[];
    project_id: string;
  },
): Promise<{ stored: number; skipped: number; total: number }> {
  const res = await fetch(`${apiUrl}/api/seed`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${memberApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      project_id: args.project_id,
      decisions: [
        {
          text: args.text,
          type: args.type,
          summary: args.summary,
          affects: args.affects,
        },
      ],
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`seed/store failed (${res.status}): ${text}`);
  }

  return res.json() as Promise<{ stored: number; skipped: number; total: number }>;
}

/** Search decisions via the /api/search endpoint. */
export async function apiSearch(
  apiUrl: string,
  jwt: string,
  query: string,
  options: {
    type?: string;
    limit?: number;
    project_id?: string;
    all_projects?: boolean;
  } = {},
): Promise<{ results: Array<{ id: string; detail: string; type: string; score: number; status?: string; [key: string]: unknown }>; count: number }> {
  const body: Record<string, unknown> = { query, ...options };

  const res = await fetch(`${apiUrl}/api/search`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${jwt}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`search failed (${res.status}): ${text}`);
  }

  return res.json() as Promise<{ results: Array<{ id: string; detail: string; type: string; score: number; status?: string }>; count: number }>;
}

/** Change decision status via /api/change-status. */
export async function apiChangeStatus(
  apiUrl: string,
  jwt: string,
  decisionId: string,
  newStatus: string,
  reason?: string,
): Promise<{ decision_id: string; old_status: string; new_status: string }> {
  const res = await fetch(`${apiUrl}/api/change-status`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${jwt}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      decision_id: decisionId,
      new_status: newStatus,
      reason,
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`change-status failed (${res.status}): ${text}`);
  }

  return res.json() as Promise<{ decision_id: string; old_status: string; new_status: string }>;
}

/** Check usage via /api/check-usage. */
export async function apiCheckUsage(
  apiUrl: string,
  jwt: string,
  orgId: string,
  operation: 'store' | 'search',
): Promise<{ allowed: boolean; plan?: string; reason?: string }> {
  const res = await fetch(`${apiUrl}/api/check-usage`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${jwt}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ org_id: orgId, operation }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`check-usage failed (${res.status}): ${text}`);
  }

  return res.json() as Promise<{ allowed: boolean; plan?: string; reason?: string }>;
}

/** Join a project via /api/join-project. */
export async function apiJoinProject(
  apiUrl: string,
  inviteCode: string,
  authorName: string,
): Promise<{
  org_id: string;
  org_name: string;
  project_id: string;
  project_name: string;
  member_api_key: string;
  member_id: string;
  supabase_url: string;
  qdrant_url: string;
  member_count: number;
  decision_count: number;
  role: string;
}> {
  const res = await fetch(`${apiUrl}/api/join-project`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      invite_code: inviteCode,
      author_name: authorName,
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`join-project failed (${res.status}): ${text}`);
  }

  return res.json() as Promise<{
    org_id: string;
    org_name: string;
    project_id: string;
    project_name: string;
    member_api_key: string;
    member_id: string;
    supabase_url: string;
    qdrant_url: string;
    member_count: number;
    decision_count: number;
    role: string;
  }>;
}

/** Create a project via /api/create-project. */
export async function apiCreateProject(
  apiUrl: string,
  jwt: string,
  projectName: string,
): Promise<{
  project_id: string;
  project_name: string;
  invite_code: string;
  role: string;
}> {
  const res = await fetch(`${apiUrl}/api/create-project`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${jwt}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ name: projectName }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`create-project failed (${res.status}): ${text}`);
  }

  return res.json() as Promise<{
    project_id: string;
    project_name: string;
    invite_code: string;
    role: string;
  }>;
}

// ---------------------------------------------------------------------------
// Retry helper — Qdrant indexing is eventually consistent
// ---------------------------------------------------------------------------

/**
 * Retry a function until it returns a truthy value or the timeout is reached.
 * Useful for waiting on Qdrant indexing after a store operation.
 */
export async function retry<T>(
  fn: () => Promise<T>,
  opts: { timeout?: number; interval?: number; label?: string } = {},
): Promise<T> {
  const timeout = opts.timeout ?? 15_000;
  const interval = opts.interval ?? 1_000;
  const label = opts.label ?? 'retry';
  const start = Date.now();

  while (true) {
    const result = await fn();
    if (result) return result;

    if (Date.now() - start > timeout) {
      throw new Error(`${label}: timed out after ${timeout}ms`);
    }

    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}
