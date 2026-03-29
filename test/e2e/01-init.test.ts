/**
 * E2E Test 1: valis init (hosted mode)
 *
 * Verifies the full registration flow:
 * - Calls /api/register to create org + project + member
 * - Response contains member_api_key, org_id, project_id, invite_code
 * - Config can be saved to ~/.valis/config.json
 * - .valis/config.json is created with project_id/project_name
 *
 * Requires: VALIS_E2E_API_URL, VALIS_E2E_SUPABASE_URL
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  canRunE2E,
  registerTestOrg,
  makeTmpDir,
  cleanTmpDir,
  writeTestProjectConfig,
  writeGlobalConfig,
  backupGlobalConfig,
  restoreGlobalConfig,
  TEST_RUN_ID,
  E2E_API_URL,
  type E2ERegistration,
} from './helpers.js';

const describeE2E = canRunE2E() ? describe : describe.skip;

describeE2E('e2e: valis init (hosted mode)', () => {
  let reg: E2ERegistration;
  let tmpDir: string;

  beforeAll(async () => {
    await backupGlobalConfig();
    tmpDir = await makeTmpDir();
    reg = await registerTestOrg('init');
  });

  afterAll(async () => {
    await restoreGlobalConfig();
    await cleanTmpDir(tmpDir);
  });

  // -------------------------------------------------------------------------
  // Registration response shape
  // -------------------------------------------------------------------------

  it('register returns all required fields', () => {
    const r = reg.response;
    expect(r.org_id).toBeTruthy();
    expect(r.org_name).toContain('e2e-test-init');
    expect(r.project_id).toBeTruthy();
    expect(r.project_name).toBe('e2e-project-init');
    expect(r.member_api_key).toMatch(/^tmm_/);
    expect(r.member_id).toBeTruthy();
    expect(r.invite_code).toBeTruthy();
    expect(r.supabase_url).toMatch(/^https:\/\//);
    expect(r.qdrant_url).toMatch(/^https:\/\//);
  });

  it('register does NOT return service_role_key or qdrant_api_key', () => {
    const keys = Object.keys(reg.response);
    expect(keys).not.toContain('service_role_key');
    expect(keys).not.toContain('supabase_service_role_key');
    expect(keys).not.toContain('qdrant_api_key');
  });

  // -------------------------------------------------------------------------
  // Config file creation
  // -------------------------------------------------------------------------

  it('builds valid ValisConfig from registration response', () => {
    const cfg = reg.config;
    expect(cfg.org_id).toBe(reg.response.org_id);
    expect(cfg.org_name).toBe(reg.response.org_name);
    expect(cfg.member_api_key).toBe(reg.response.member_api_key);
    expect(cfg.member_id).toBe(reg.response.member_id);
    expect(cfg.supabase_url).toBe(reg.response.supabase_url);
    expect(cfg.auth_mode).toBe('jwt');
    // Hosted mode: no service_role or qdrant_api_key on client
    expect(cfg.supabase_service_role_key).toBe('');
    expect(cfg.qdrant_api_key).toBe('');
  });

  it('writes and reads back ~/.valis/config.json', async () => {
    await writeGlobalConfig(reg.config);

    const { loadConfig } = await import('../../src/config/store.js');
    const loaded = await loadConfig();
    expect(loaded).not.toBeNull();
    expect(loaded!.org_id).toBe(reg.config.org_id);
    expect(loaded!.member_api_key).toBe(reg.config.member_api_key);
  });

  // -------------------------------------------------------------------------
  // .valis/config.json project config
  // -------------------------------------------------------------------------

  it('writes .valis/config.json with project_id and project_name only', async () => {
    await writeTestProjectConfig(tmpDir, reg.projectConfig);

    const raw = await readFile(join(tmpDir, '.valis/config.json'), 'utf-8');
    const parsed = JSON.parse(raw);
    const keys = Object.keys(parsed);

    expect(keys).toContain('project_id');
    expect(keys).toContain('project_name');
    expect(keys).not.toContain('api_key');
    expect(keys).not.toContain('member_api_key');
    expect(keys).not.toContain('supabase_url');
    expect(keys).not.toContain('org_id');

    expect(parsed.project_id).toBe(reg.response.project_id);
    expect(parsed.project_name).toBe('e2e-project-init');
  });

  // -------------------------------------------------------------------------
  // Registration validation
  // -------------------------------------------------------------------------

  it('rejects duplicate org name with 409', async () => {
    const res = await fetch(`${E2E_API_URL}/api/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        org_name: reg.response.org_name,
        project_name: 'dup-project',
        author_name: 'dup-author',
      }),
    });

    expect(res.status).toBe(409);
  });

  it('rejects invalid org name with 400', async () => {
    const res = await fetch(`${E2E_API_URL}/api/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        org_name: '!!!invalid!!!',
        project_name: 'valid-project',
        author_name: 'valid-author',
      }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('invalid_name');
  });

  it('rejects missing fields with 400', async () => {
    const res = await fetch(`${E2E_API_URL}/api/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ org_name: 'test' }),
    });

    expect(res.status).toBe(400);
  });
});
