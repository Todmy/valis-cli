import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadHookGlobalConfig, loadHookMarker } from '../../src/hooks/context.js';

let tempHome: string;
let tempCwd: string;
let originalValisHome: string | undefined;
let originalProjectDir: string | undefined;

beforeEach(async () => {
  tempHome = await mkdtemp(join(tmpdir(), 'valis-home-'));
  tempCwd = await mkdtemp(join(tmpdir(), 'valis-cwd-'));
  originalValisHome = process.env.VALIS_HOME;
  originalProjectDir = process.env.CLAUDE_PROJECT_DIR;
  process.env.VALIS_HOME = tempHome;
  process.env.CLAUDE_PROJECT_DIR = tempCwd;
});

afterEach(async () => {
  await rm(tempHome, { recursive: true, force: true });
  await rm(tempCwd, { recursive: true, force: true });
  if (originalValisHome === undefined) delete process.env.VALIS_HOME;
  else process.env.VALIS_HOME = originalValisHome;
  if (originalProjectDir === undefined) delete process.env.CLAUDE_PROJECT_DIR;
  else process.env.CLAUDE_PROJECT_DIR = originalProjectDir;
});

async function writeGlobal(data: unknown): Promise<void> {
  await mkdir(tempHome, { recursive: true });
  await writeFile(join(tempHome, 'config.json'), JSON.stringify(data), 'utf-8');
}

describe('loadHookGlobalConfig', () => {
  it('returns the bundle when org_id and member_api_key are set', async () => {
    await writeGlobal({
      org_id: 'org-1',
      member_api_key: 'tmm_member',
      api_key: 'tm_org',
      api_base_url: 'https://example.test',
    });
    const ctx = await loadHookGlobalConfig();
    expect(ctx).not.toBeNull();
    expect(ctx!.orgId).toBe('org-1');
    expect(ctx!.apiKey).toBe('tmm_member');
    expect(ctx!.apiBaseUrl).toBe('https://example.test');
  });

  it('falls back to api_key when member_api_key is absent', async () => {
    await writeGlobal({ org_id: 'org-1', api_key: 'tm_legacy' });
    const ctx = await loadHookGlobalConfig();
    expect(ctx!.apiKey).toBe('tm_legacy');
  });

  it('returns empty apiKey when neither key is set', async () => {
    await writeGlobal({ org_id: 'org-1' });
    const ctx = await loadHookGlobalConfig();
    expect(ctx).not.toBeNull();
    expect(ctx!.apiKey).toBe('');
  });

  it('uses default api base URL when api_base_url missing', async () => {
    await writeGlobal({ org_id: 'org-1' });
    const ctx = await loadHookGlobalConfig();
    expect(ctx!.apiBaseUrl).toBe('https://valis.krukit.co');
  });

  it('returns null when config file missing', async () => {
    const ctx = await loadHookGlobalConfig();
    expect(ctx).toBeNull();
  });

  it('returns null when org_id missing', async () => {
    await writeGlobal({ member_api_key: 'tmm_x' });
    const ctx = await loadHookGlobalConfig();
    expect(ctx).toBeNull();
  });

  it('returns null on invalid JSON', async () => {
    await mkdir(tempHome, { recursive: true });
    await writeFile(join(tempHome, 'config.json'), '{ not valid', 'utf-8');
    const ctx = await loadHookGlobalConfig();
    expect(ctx).toBeNull();
  });

  it('returns null when JSON is not an object', async () => {
    await mkdir(tempHome, { recursive: true });
    await writeFile(join(tempHome, 'config.json'), '[]', 'utf-8');
    const ctx = await loadHookGlobalConfig();
    expect(ctx).toBeNull();
  });

  it('exposes raw for handler-specific fields', async () => {
    await writeGlobal({
      org_id: 'org-1',
      per_prompt_augmentation: false,
      per_prompt_threshold: 0.5,
    });
    const ctx = await loadHookGlobalConfig();
    expect(ctx!.raw.per_prompt_augmentation).toBe(false);
    expect(ctx!.raw.per_prompt_threshold).toBe(0.5);
  });
});

describe('loadHookMarker', () => {
  it('returns the marker via findProjectMarker', async () => {
    await mkdir(join(tempCwd, '.valis'), { recursive: true });
    await writeFile(
      join(tempCwd, '.valis', 'config.json'),
      JSON.stringify({
        project_id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
        project_name: 'project-one',
      }),
      'utf-8',
    );
    const marker = await loadHookMarker();
    expect(marker).not.toBeNull();
    expect(marker!.projectId).toBe('a1b2c3d4-e5f6-7890-abcd-ef1234567890');
  });

  it('returns null when no marker', async () => {
    const marker = await loadHookMarker();
    expect(marker).toBeNull();
  });

  it('returns null when marker has empty project_id', async () => {
    await writeFile(
      join(tempCwd, '.valis.json'),
      JSON.stringify({ project_name: 'no-id' }),
      'utf-8',
    );
    const marker = await loadHookMarker();
    expect(marker).toBeNull();
  });
});
