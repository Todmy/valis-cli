import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  findProjectConfig,
  findProjectConfigPath,
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
  return mkdtemp(join(tmpdir(), 'teamind-test-'));
}

async function writeJson(dir: string, filename: string, data: unknown): Promise<void> {
  await writeFile(join(dir, filename), JSON.stringify(data, null, 2), 'utf-8');
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

  it('finds .teamind.json in the start directory', async () => {
    const config = {
      project_id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
      project_name: 'test-project',
    };
    await writeJson(tempRoot, '.teamind.json', config);

    const result = await findProjectConfig(tempRoot);
    expect(result).toEqual(config);
  });

  it('finds .teamind.json in a parent directory', async () => {
    const config = {
      project_id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
      project_name: 'parent-project',
    };
    await writeJson(tempRoot, '.teamind.json', config);

    const childDir = join(tempRoot, 'src', 'components');
    await mkdir(childDir, { recursive: true });

    const result = await findProjectConfig(childDir);
    expect(result).toEqual(config);
  });

  it('closest .teamind.json wins in nested directories', async () => {
    const parentConfig = {
      project_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      project_name: 'parent',
    };
    const childConfig = {
      project_id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
      project_name: 'child',
    };

    await writeJson(tempRoot, '.teamind.json', parentConfig);

    const childDir = join(tempRoot, 'packages', 'child');
    await mkdir(childDir, { recursive: true });
    await writeJson(childDir, '.teamind.json', childConfig);

    const result = await findProjectConfig(childDir);
    expect(result).toEqual(childConfig);

    // From parent level, should get parent config
    const parentResult = await findProjectConfig(tempRoot);
    expect(parentResult).toEqual(parentConfig);
  });

  it('returns null when no .teamind.json found (stops at root)', async () => {
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

  it('returns the path to the found .teamind.json', async () => {
    const config = {
      project_id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
      project_name: 'test-project',
    };
    await writeJson(tempRoot, '.teamind.json', config);

    const result = await findProjectConfigPath(tempRoot);
    expect(result).toBe(join(tempRoot, '.teamind.json'));
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
    const filePath = join(tempRoot, '.teamind.json');
    await writeFile(filePath, JSON.stringify(config), 'utf-8');

    const result = await loadProjectConfig(filePath);
    expect(result).toEqual(config);
  });

  it('throws on invalid JSON', async () => {
    const filePath = join(tempRoot, '.teamind.json');
    await writeFile(filePath, '{ not valid json }', 'utf-8');

    await expect(loadProjectConfig(filePath)).rejects.toThrow('Invalid .teamind.json');
  });

  it('throws on missing required fields', async () => {
    const filePath = join(tempRoot, '.teamind.json');
    await writeFile(filePath, JSON.stringify({ project_name: 'test' }), 'utf-8');

    await expect(loadProjectConfig(filePath)).rejects.toThrow('Invalid .teamind.json');
  });

  it('throws on invalid UUID', async () => {
    const filePath = join(tempRoot, '.teamind.json');
    await writeFile(
      filePath,
      JSON.stringify({ project_id: 'bad-uuid', project_name: 'test' }),
      'utf-8',
    );

    await expect(loadProjectConfig(filePath)).rejects.toThrow('Invalid .teamind.json');
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
    expect(writtenPath).toBe(join(tempRoot, '.teamind.json'));

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

  it('returns project: null when no .teamind.json exists', async () => {
    const result = await resolveConfig(tempRoot);
    expect(result.project).toBeNull();
    // global may or may not be null depending on host machine config
  });

  it('returns project config when .teamind.json exists', async () => {
    const config = {
      project_id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
      project_name: 'resolved-project',
    };
    await writeJson(tempRoot, '.teamind.json', config);

    const result = await resolveConfig(tempRoot);
    expect(result.project).toEqual(config);
  });

  it('resolves from child directory via walk-up', async () => {
    const config = {
      project_id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
      project_name: 'walk-up-project',
    };
    await writeJson(tempRoot, '.teamind.json', config);

    const deepChild = join(tempRoot, 'a', 'b', 'c');
    await mkdir(deepChild, { recursive: true });

    const result = await resolveConfig(deepChild);
    expect(result.project).toEqual(config);
  });
});
