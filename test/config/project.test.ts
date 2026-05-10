import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import {
  findProjectConfig,
  findProjectConfigPath,
  findProjectMarker,
  loadProjectConfig,
  writeProjectConfig,
  resolveConfig,
  projectConfigSchema,
} from '../../src/config/project.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tempRoot: string;

async function createTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'valis-test-'));
}

async function writeJson(dir: string, filename: string, data: unknown): Promise<void> {
  const filePath = join(dir, filename);
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('projectConfigSchema', () => {
  it('accepts valid config', () => {
    const result = projectConfigSchema.safeParse({
      project_id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
      project_name: 'frontend-app',
    });
    expect(result.success).toBe(true);
  });

  it('rejects missing project_id', () => {
    const result = projectConfigSchema.safeParse({
      project_name: 'frontend-app',
    });
    expect(result.success).toBe(false);
  });

  it('rejects invalid UUID for project_id', () => {
    const result = projectConfigSchema.safeParse({
      project_id: 'not-a-uuid',
      project_name: 'frontend-app',
    });
    expect(result.success).toBe(false);
  });

  it('rejects empty project_name', () => {
    const result = projectConfigSchema.safeParse({
      project_id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
      project_name: '',
    });
    expect(result.success).toBe(false);
  });

  it('rejects project_name exceeding 100 chars', () => {
    const result = projectConfigSchema.safeParse({
      project_id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
      project_name: 'x'.repeat(101),
    });
    expect(result.success).toBe(false);
  });

  it('accepts project_name of exactly 100 chars', () => {
    const result = projectConfigSchema.safeParse({
      project_id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
      project_name: 'x'.repeat(100),
    });
    expect(result.success).toBe(true);
  });
});

describe('findProjectConfig — walk-up', () => {
  beforeEach(async () => {
    tempRoot = await createTempDir();
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  it('finds .valis/config.json in the start directory', async () => {
    const config = {
      project_id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
      project_name: 'test-project',
    };
    await writeJson(tempRoot, '.valis/config.json', config);

    const result = await findProjectConfig(tempRoot);
    expect(result).toEqual(config);
  });

  it('finds .valis/config.json in a parent directory', async () => {
    const config = {
      project_id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
      project_name: 'parent-project',
    };
    await writeJson(tempRoot, '.valis/config.json', config);

    const childDir = join(tempRoot, 'src', 'components');
    await mkdir(childDir, { recursive: true });

    const result = await findProjectConfig(childDir);
    expect(result).toEqual(config);
  });

  it('closest .valis/config.json wins in nested directories', async () => {
    const parentConfig = {
      project_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      project_name: 'parent',
    };
    const childConfig = {
      project_id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
      project_name: 'child',
    };

    await writeJson(tempRoot, '.valis/config.json', parentConfig);

    const childDir = join(tempRoot, 'packages', 'child');
    await mkdir(childDir, { recursive: true });
    await writeJson(childDir, '.valis/config.json', childConfig);

    const result = await findProjectConfig(childDir);
    expect(result).toEqual(childConfig);

    // From parent level, should get parent config
    const parentResult = await findProjectConfig(tempRoot);
    expect(parentResult).toEqual(parentConfig);
  });

  it('returns null when no .valis/config.json found (stops at root)', async () => {
    const emptyDir = join(tempRoot, 'empty');
    await mkdir(emptyDir, { recursive: true });

    const result = await findProjectConfig(emptyDir);
    expect(result).toBeNull();
  });
});

describe('findProjectConfigPath', () => {
  beforeEach(async () => {
    tempRoot = await createTempDir();
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  it('returns the path to the found .valis/config.json', async () => {
    const config = {
      project_id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
      project_name: 'test-project',
    };
    await writeJson(tempRoot, '.valis/config.json', config);

    const result = await findProjectConfigPath(tempRoot);
    expect(result).toBe(join(tempRoot, '.valis/config.json'));
  });

  it('returns null when not found', async () => {
    const result = await findProjectConfigPath(tempRoot);
    expect(result).toBeNull();
  });
});

describe('loadProjectConfig', () => {
  beforeEach(async () => {
    tempRoot = await createTempDir();
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  it('loads valid config', async () => {
    const config = {
      project_id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
      project_name: 'my-project',
    };
    const filePath = join(tempRoot, '.valis/config.json');
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, JSON.stringify(config), 'utf-8');

    const result = await loadProjectConfig(filePath);
    expect(result).toEqual(config);
  });

  it('throws on invalid JSON', async () => {
    const filePath = join(tempRoot, '.valis/config.json');
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, '{ not valid json }', 'utf-8');

    await expect(loadProjectConfig(filePath)).rejects.toThrow('Invalid .valis/config.json');
  });

  it('throws on missing required fields', async () => {
    const filePath = join(tempRoot, '.valis/config.json');
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, JSON.stringify({ project_name: 'test' }), 'utf-8');

    await expect(loadProjectConfig(filePath)).rejects.toThrow('Invalid .valis/config.json');
  });

  it('throws on invalid UUID', async () => {
    const filePath = join(tempRoot, '.valis/config.json');
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(
      filePath,
      JSON.stringify({ project_id: 'bad-uuid', project_name: 'test' }),
      'utf-8',
    );

    await expect(loadProjectConfig(filePath)).rejects.toThrow('Invalid .valis/config.json');
  });
});

describe('writeProjectConfig', () => {
  beforeEach(async () => {
    tempRoot = await createTempDir();
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  it('writes correct JSON file', async () => {
    const config = {
      project_id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
      project_name: 'written-project',
    };

    const writtenPath = await writeProjectConfig(tempRoot, config);
    expect(writtenPath).toBe(join(tempRoot, '.valis/config.json'));

    const content = await readFile(writtenPath, 'utf-8');
    const parsed = JSON.parse(content);
    expect(parsed.project_id).toBe(config.project_id);
    expect(parsed.project_name).toBe(config.project_name);
  });

  it('produces valid config that can be loaded back', async () => {
    const config = {
      project_id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
      project_name: 'roundtrip-project',
    };

    const writtenPath = await writeProjectConfig(tempRoot, config);
    const loaded = await loadProjectConfig(writtenPath);
    expect(loaded).toEqual(config);
  });
});

describe('resolveConfig', () => {
  beforeEach(async () => {
    tempRoot = await createTempDir();
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  it('returns project: null when no .valis/config.json exists', async () => {
    const result = await resolveConfig(tempRoot);
    expect(result.project).toBeNull();
    // global may or may not be null depending on host machine config
  });

  it('returns project config when .valis/config.json exists', async () => {
    const config = {
      project_id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
      project_name: 'resolved-project',
    };
    await writeJson(tempRoot, '.valis/config.json', config);

    const result = await resolveConfig(tempRoot);
    expect(result.project).toEqual(config);
  });

  it('resolves from child directory via walk-up', async () => {
    const config = {
      project_id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
      project_name: 'walk-up-project',
    };
    await writeJson(tempRoot, '.valis/config.json', config);

    const deepChild = join(tempRoot, 'a', 'b', 'c');
    await mkdir(deepChild, { recursive: true });

    const result = await resolveConfig(deepChild);
    expect(result.project).toEqual(config);
  });
});

describe('findProjectMarker — lenient walk-up for hooks', () => {
  beforeEach(async () => {
    tempRoot = await createTempDir();
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  it('returns marker with projectDir set to the directory containing .valis/config.json', async () => {
    const config = {
      project_id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
      project_name: 'new-format',
    };
    await writeJson(tempRoot, '.valis/config.json', config);

    const result = await findProjectMarker(tempRoot);
    expect(result).not.toBeNull();
    expect(result!.projectDir).toBe(tempRoot);
    expect(result!.projectId).toBe(config.project_id);
    expect(result!.projectName).toBe(config.project_name);
    expect(result!.raw).toEqual(config);
  });

  it('finds legacy .valis.json with projectDir at the marker dir', async () => {
    const config = {
      project_id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
      project_name: 'legacy-format',
    };
    await writeJson(tempRoot, '.valis.json', config);

    const result = await findProjectMarker(tempRoot);
    expect(result).not.toBeNull();
    expect(result!.projectDir).toBe(tempRoot);
    expect(result!.raw).toEqual(config);
  });

  it('preserves arbitrary fields in raw (per-prompt overrides etc.)', async () => {
    const config = {
      project_id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
      project_name: 'with-overrides',
      per_prompt_augmentation: false,
      per_prompt_threshold: 0.6,
    };
    await writeJson(tempRoot, '.valis.json', config);

    const result = await findProjectMarker(tempRoot);
    expect(result!.raw.per_prompt_augmentation).toBe(false);
    expect(result!.raw.per_prompt_threshold).toBe(0.6);
  });

  it('walks up from a child directory', async () => {
    const config = {
      project_id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
      project_name: 'walk-up',
    };
    await writeJson(tempRoot, '.valis/config.json', config);
    const child = join(tempRoot, 'src', 'a', 'b');
    await mkdir(child, { recursive: true });

    const result = await findProjectMarker(child);
    expect(result).not.toBeNull();
    expect(result!.projectDir).toBe(tempRoot);
  });

  it('returns null when no marker exists', async () => {
    const empty = join(tempRoot, 'empty');
    await mkdir(empty, { recursive: true });
    const result = await findProjectMarker(empty);
    expect(result).toBeNull();
  });

  it('returns null when marker lacks project_id (treats missing field as not-configured)', async () => {
    await writeJson(tempRoot, '.valis.json', { project_name: 'no-id' });
    const result = await findProjectMarker(tempRoot);
    expect(result).toBeNull();
  });

  it('returns null on invalid JSON', async () => {
    const path = join(tempRoot, '.valis.json');
    await writeFile(path, '{ not valid json', 'utf-8');
    const result = await findProjectMarker(tempRoot);
    expect(result).toBeNull();
  });

  it('returns null when JSON parses to a non-object', async () => {
    const path = join(tempRoot, '.valis.json');
    await writeFile(path, '"just a string"', 'utf-8');
    const result = await findProjectMarker(tempRoot);
    expect(result).toBeNull();
  });

  it('basename fallback for missing project_name', async () => {
    await writeJson(tempRoot, '.valis.json', {
      project_id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    });
    const result = await findProjectMarker(tempRoot);
    expect(result!.projectName).toBe(tempRoot.split('/').pop());
  });
});
