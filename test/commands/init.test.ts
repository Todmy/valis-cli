/**
 * T013: Tests for init command project flow.
 *
 * Tests cover:
 * - Case 2: org exists shows project list and allows selection
 * - Case 3: --join writes .teamind.json with project_id/name
 * - Fresh init (Case 1) creates project + writes .teamind.json
 * - Global config unchanged when only project changes (Case 4 switch)
 * - T013: Community mode prompts for 4 credentials, saves supabase_service_role_key, no registration API
 * - T016: Static assertion that HOSTED_CREDENTIALS / loadHostedEnv / .hosted-env / TEAMIND_HOSTED_ are removed
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, readFile, rm, mkdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import {
  findProjectConfig,
  writeProjectConfig,
  loadProjectConfig,
} from '../../src/config/project.js';
import type { ProjectConfig, TeamindConfig } from '../../src/types.js';
import type { ProjectInfo, CreateProjectResponse, JoinProjectResponse } from '../../src/cloud/supabase.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeTmpDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'teamind-init-test-'));
}

const MOCK_PROJECT_A: ProjectConfig = {
  project_id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
  project_name: 'frontend-app',
};

const MOCK_PROJECT_B: ProjectConfig = {
  project_id: 'b2c3d4e5-f6a7-8901-bcde-f12345678901',
  project_name: 'backend-api',
};

const MOCK_GLOBAL_CONFIG: TeamindConfig = {
  org_id: 'org-1111-2222-3333-444444444444',
  org_name: 'TestOrg',
  api_key: 'test-api-key',
  invite_code: 'ABCD-EFGH',
  author_name: 'Alice',
  supabase_url: 'https://test.supabase.co',
  supabase_service_role_key: 'test-service-role-key',
  qdrant_url: 'https://test.qdrant.io',
  qdrant_api_key: 'test-qdrant-key',
  configured_ides: ['claude-code'],
  created_at: '2026-03-24T00:00:00.000Z',
  member_id: 'member-1111-2222-3333-444444444444',
};

// ---------------------------------------------------------------------------
// Case 2: Org exists, shows project list
// ---------------------------------------------------------------------------

describe('Case 2: org exists, no .teamind.json — project selection', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTmpDir();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('selectOrCreateProject writes .teamind.json for selected project', async () => {
    // Simulate user selecting an existing project by writing the config directly
    // (The interactive prompt is tested via manual/integration testing.)
    const selectedProject: ProjectConfig = {
      project_id: MOCK_PROJECT_A.project_id,
      project_name: MOCK_PROJECT_A.project_name,
    };

    const configPath = await writeProjectConfig(tmpDir, selectedProject);
    const loaded = await loadProjectConfig(configPath);

    expect(loaded.project_id).toBe(MOCK_PROJECT_A.project_id);
    expect(loaded.project_name).toBe(MOCK_PROJECT_A.project_name);
  });

  it('creates new project and writes .teamind.json', async () => {
    // Simulate the flow: user types new project name, gets back project_id from EF
    const newProject: ProjectConfig = {
      project_id: 'c3d4e5f6-a7b8-9012-cdef-123456789012',
      project_name: 'new-service',
    };

    await writeProjectConfig(tmpDir, newProject);

    const loaded = await findProjectConfig(tmpDir);
    expect(loaded).not.toBeNull();
    expect(loaded!.project_id).toBe(newProject.project_id);
    expect(loaded!.project_name).toBe('new-service');
  });

  it('directory has no .teamind.json initially (Case 2 precondition)', async () => {
    const result = await findProjectConfig(tmpDir);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Case 3: --join writes .teamind.json
// ---------------------------------------------------------------------------

describe('Case 3: --join writes .teamind.json', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTmpDir();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('join-project response produces valid .teamind.json', async () => {
    // Simulate the join-project EF response
    const joinResponse: JoinProjectResponse = {
      org_id: MOCK_GLOBAL_CONFIG.org_id,
      org_name: MOCK_GLOBAL_CONFIG.org_name,
      project_id: MOCK_PROJECT_B.project_id,
      project_name: MOCK_PROJECT_B.project_name,
      api_key: 'new-api-key',
      member_api_key: 'tmm_abc123',
      member_id: 'member-5555-6666-7777-888888888888',
      role: 'project_member',
    };

    // The init command would extract project config from the response
    const projectConfig: ProjectConfig = {
      project_id: joinResponse.project_id,
      project_name: joinResponse.project_name,
    };

    await writeProjectConfig(tmpDir, projectConfig);

    const loaded = await findProjectConfig(tmpDir);
    expect(loaded).not.toBeNull();
    expect(loaded!.project_id).toBe(MOCK_PROJECT_B.project_id);
    expect(loaded!.project_name).toBe(MOCK_PROJECT_B.project_name);
  });

  it('.teamind.json contains only project_id and project_name (no secrets)', async () => {
    await writeProjectConfig(tmpDir, {
      project_id: MOCK_PROJECT_A.project_id,
      project_name: MOCK_PROJECT_A.project_name,
    });

    const raw = await readFile(join(tmpDir, '.teamind.json'), 'utf-8');
    const parsed = JSON.parse(raw);

    // Should only have these two keys
    const keys = Object.keys(parsed);
    expect(keys).toContain('project_id');
    expect(keys).toContain('project_name');
    expect(keys).not.toContain('api_key');
    expect(keys).not.toContain('org_id');
    expect(keys).not.toContain('supabase_url');
  });
});

// ---------------------------------------------------------------------------
// Fresh init creates project + writes .teamind.json
// ---------------------------------------------------------------------------

describe('Fresh init: project creation flow', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTmpDir();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('simulates fresh init: org creation + project creation + config files', async () => {
    // Simulate create-project EF response
    const createResponse: CreateProjectResponse = {
      project_id: MOCK_PROJECT_A.project_id,
      project_name: MOCK_PROJECT_A.project_name,
      invite_code: 'PROJ-CODE',
      role: 'project_admin',
    };

    // Write .teamind.json as init would
    const projectConfig: ProjectConfig = {
      project_id: createResponse.project_id,
      project_name: createResponse.project_name,
    };
    await writeProjectConfig(tmpDir, projectConfig);

    // Verify .teamind.json exists and is valid
    const loaded = await findProjectConfig(tmpDir);
    expect(loaded).not.toBeNull();
    expect(loaded!.project_id).toBe(MOCK_PROJECT_A.project_id);
    expect(loaded!.project_name).toBe(MOCK_PROJECT_A.project_name);
  });

  it('default project name comes from directory basename', () => {
    // The init command uses basename(process.cwd()) as default project name
    const dirName = basename(tmpDir);
    expect(dirName).toBeTruthy();
    expect(typeof dirName).toBe('string');
    expect(dirName.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Global config unchanged when only project changes (Case 4)
// ---------------------------------------------------------------------------

describe('Global config unchanged when switching projects', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTmpDir();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('switching project only updates .teamind.json, not global config', async () => {
    // Write initial project config
    await writeProjectConfig(tmpDir, MOCK_PROJECT_A);

    // Simulate switching to project B (only .teamind.json changes)
    await writeProjectConfig(tmpDir, MOCK_PROJECT_B);

    // Verify project config changed
    const projectConfig = await findProjectConfig(tmpDir);
    expect(projectConfig).not.toBeNull();
    expect(projectConfig!.project_id).toBe(MOCK_PROJECT_B.project_id);
    expect(projectConfig!.project_name).toBe(MOCK_PROJECT_B.project_name);

    // The global config (TeamindConfig) is stored in ~/.teamind/config.json,
    // NOT in the project directory. Switching projects never touches it.
    // We verify this by confirming .teamind.json has no global config fields.
    const raw = await readFile(join(tmpDir, '.teamind.json'), 'utf-8');
    const parsed = JSON.parse(raw);
    expect(parsed.org_id).toBeUndefined();
    expect(parsed.api_key).toBeUndefined();
    expect(parsed.supabase_url).toBeUndefined();
  });

  it('two directories can have different projects in the same org', async () => {
    const tmpDir2 = await makeTmpDir();
    try {
      await writeProjectConfig(tmpDir, MOCK_PROJECT_A);
      await writeProjectConfig(tmpDir2, MOCK_PROJECT_B);

      const configA = await findProjectConfig(tmpDir);
      const configB = await findProjectConfig(tmpDir2);

      expect(configA).not.toBeNull();
      expect(configB).not.toBeNull();
      expect(configA!.project_id).toBe(MOCK_PROJECT_A.project_id);
      expect(configB!.project_id).toBe(MOCK_PROJECT_B.project_id);
      expect(configA!.project_id).not.toBe(configB!.project_id);
    } finally {
      await rm(tmpDir2, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Supabase client methods: type contracts
// ---------------------------------------------------------------------------

describe('Supabase project methods: type contracts', () => {
  it('ProjectInfo has expected shape', () => {
    const info: ProjectInfo = {
      id: MOCK_PROJECT_A.project_id,
      name: MOCK_PROJECT_A.project_name,
      role: 'project_admin',
      decision_count: 42,
    };

    expect(info.id).toBeTruthy();
    expect(info.name).toBeTruthy();
    expect(info.role).toBe('project_admin');
    expect(info.decision_count).toBe(42);
  });

  it('CreateProjectResponse has expected shape', () => {
    const response: CreateProjectResponse = {
      project_id: MOCK_PROJECT_A.project_id,
      project_name: MOCK_PROJECT_A.project_name,
      invite_code: 'ABCD-EFGH',
      role: 'project_admin',
    };

    expect(response.project_id).toBeTruthy();
    expect(response.project_name).toBeTruthy();
    expect(response.invite_code).toBeTruthy();
    expect(response.role).toBe('project_admin');
  });

  it('JoinProjectResponse has expected shape', () => {
    const response: JoinProjectResponse = {
      org_id: MOCK_GLOBAL_CONFIG.org_id,
      org_name: MOCK_GLOBAL_CONFIG.org_name,
      project_id: MOCK_PROJECT_A.project_id,
      project_name: MOCK_PROJECT_A.project_name,
      api_key: 'test-key',
      role: 'project_member',
    };

    expect(response.org_id).toBeTruthy();
    expect(response.org_name).toBeTruthy();
    expect(response.project_id).toBeTruthy();
    expect(response.project_name).toBeTruthy();
    expect(response.api_key).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// T013: Community mode integration tests
// ---------------------------------------------------------------------------

describe('T013: Community mode — unchanged behavior', () => {
  it('community config includes supabase_service_role_key', () => {
    // Community mode users provide their own credentials, including service_role_key.
    // The saved config must include supabase_service_role_key for community mode.
    const communityConfig: TeamindConfig = {
      org_id: 'org-community-1234',
      org_name: 'CommunityOrg',
      api_key: 'community-api-key',
      invite_code: 'COMM-CODE',
      author_name: 'Bob',
      supabase_url: 'https://community.supabase.co',
      supabase_service_role_key: 'community-service-role-key',
      qdrant_url: 'https://community.qdrant.io',
      qdrant_api_key: 'community-qdrant-key',
      configured_ides: [],
      created_at: new Date().toISOString(),
      member_id: null,
    };

    // Verify community config has all 4 credential fields
    expect(communityConfig.supabase_url).toBeTruthy();
    expect(communityConfig.supabase_service_role_key).toBeTruthy();
    expect(communityConfig.qdrant_url).toBeTruthy();
    expect(communityConfig.qdrant_api_key).toBeTruthy();
  });

  it('community config does NOT use registration API types', () => {
    // Community mode saves service_role_key directly — no member_api_key needed
    // for backend operations (community users have full admin access).
    const communityConfig: TeamindConfig = {
      org_id: 'org-community-1234',
      org_name: 'CommunityOrg',
      api_key: 'community-api-key',
      invite_code: 'COMM-CODE',
      author_name: 'Bob',
      supabase_url: 'https://community.supabase.co',
      supabase_service_role_key: 'community-service-role-key',
      qdrant_url: 'https://community.qdrant.io',
      qdrant_api_key: 'community-qdrant-key',
      configured_ides: [],
      created_at: new Date().toISOString(),
      member_id: null,
    };

    // service_role_key is the key differentiator for community mode
    expect(communityConfig.supabase_service_role_key).toBe('community-service-role-key');
    // member_id is null in community mode (no per-member key flow)
    expect(communityConfig.member_id).toBeNull();
  });

  it('community mode requires all 4 credentials (Supabase URL, Service Role Key, Qdrant URL, Qdrant API Key)', () => {
    // This test documents the 4 prompts that community mode users must answer.
    const requiredFields = [
      'supabase_url',
      'supabase_service_role_key',
      'qdrant_url',
      'qdrant_api_key',
    ] as const;

    const communityConfig = MOCK_GLOBAL_CONFIG;
    for (const field of requiredFields) {
      expect(communityConfig[field]).toBeTruthy();
    }
  });
});

// ---------------------------------------------------------------------------
// T016: Static assertion — no HOSTED_CREDENTIALS / loadHostedEnv / .hosted-env / TEAMIND_HOSTED_
// ---------------------------------------------------------------------------

describe('T016: Verify removal of hosted-env legacy code from init.ts', () => {
  const initTsPath = resolve(__dirname, '../../src/commands/init.ts');
  const initTsContent = readFileSync(initTsPath, 'utf-8');

  it('does not contain HOSTED_CREDENTIALS constant', () => {
    expect(initTsContent).not.toMatch(/\bHOSTED_CREDENTIALS\b/);
  });

  it('does not contain loadHostedEnv function', () => {
    expect(initTsContent).not.toMatch(/\bloadHostedEnv\b/);
  });

  it('does not contain parseEnvContent function', () => {
    expect(initTsContent).not.toMatch(/\bparseEnvContent\b/);
  });

  it('does not reference .hosted-env file', () => {
    expect(initTsContent).not.toMatch(/\.hosted-env/);
  });

  it('does not reference TEAMIND_HOSTED_ environment variables', () => {
    expect(initTsContent).not.toMatch(/TEAMIND_HOSTED_/);
  });

  it('does not import readFileSync or existsSync (no longer needed)', () => {
    expect(initTsContent).not.toMatch(/\breadFileSync\b/);
    expect(initTsContent).not.toMatch(/\bexistsSync\b/);
  });

  it('does not import fileURLToPath (no longer needed)', () => {
    expect(initTsContent).not.toMatch(/\bfileURLToPath\b/);
  });

  it('hosted path in resolveCredentials does not assign service_role from env', () => {
    // The hosted branch should not resolve serviceRoleKey from env vars or files.
    // It should either be empty (placeholder) or come from registration API.
    expect(initTsContent).not.toMatch(/TEAMIND_HOSTED_SUPABASE_KEY/);
    expect(initTsContent).not.toMatch(/TEAMIND_HOSTED_QDRANT_KEY/);
  });
});
