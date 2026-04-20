import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseValisYaml, ValisYamlError } from '../../src/config/valis-yaml.js';

let tempRoot: string;
const VALID_UUID = '01930000-0000-7000-8000-000000000001';

async function makeRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'valis-yaml-test-'));
  await mkdir(join(dir, '.git'), { recursive: true });
  return dir;
}

async function writeYaml(dir: string, contents: string): Promise<void> {
  await writeFile(join(dir, '.valis.yaml'), contents, 'utf8');
}

beforeEach(async () => {
  tempRoot = await makeRepo();
});

afterEach(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

describe('parseValisYaml', () => {
  it('returns null when no config file exists up to repo root', async () => {
    const deep = join(tempRoot, 'src', 'nested');
    await mkdir(deep, { recursive: true });
    const result = await parseValisYaml(deep);
    expect(result).toBeNull();
  });

  it('parses a minimal valid config from the repo root', async () => {
    await writeYaml(tempRoot, `project_id: ${VALID_UUID}\n`);
    const result = await parseValisYaml(tempRoot);
    expect(result).toEqual({ project_id: VALID_UUID });
  });

  it('parses enforcement_mode when present', async () => {
    await writeYaml(
      tempRoot,
      `project_id: ${VALID_UUID}\nenforcement_mode: block\n`,
    );
    const result = await parseValisYaml(tempRoot);
    expect(result).toEqual({ project_id: VALID_UUID, enforcement_mode: 'block' });
  });

  it('walks up from a nested CWD to find the config', async () => {
    await writeYaml(tempRoot, `project_id: ${VALID_UUID}\n`);
    const deep = join(tempRoot, 'src', 'a', 'b');
    await mkdir(deep, { recursive: true });
    const result = await parseValisYaml(deep);
    expect(result?.project_id).toBe(VALID_UUID);
  });

  it('does not cross the repo boundary (.git marks the stop)', async () => {
    // Config lives ABOVE the inner repo root — should not be picked up.
    await writeYaml(tempRoot, `project_id: ${VALID_UUID}\n`);
    const inner = join(tempRoot, 'packages', 'inner-repo');
    await mkdir(join(inner, '.git'), { recursive: true });
    const result = await parseValisYaml(inner);
    expect(result).toBeNull();
  });

  it('throws ValisYamlError on invalid UUID', async () => {
    await writeYaml(tempRoot, `project_id: not-a-uuid\n`);
    await expect(parseValisYaml(tempRoot)).rejects.toBeInstanceOf(
      ValisYamlError,
    );
  });

  it('throws ValisYamlError on invalid enforcement_mode', async () => {
    await writeYaml(
      tempRoot,
      `project_id: ${VALID_UUID}\nenforcement_mode: aggressive\n`,
    );
    await expect(parseValisYaml(tempRoot)).rejects.toBeInstanceOf(
      ValisYamlError,
    );
  });

  it('throws ValisYamlError on malformed YAML', async () => {
    await writeYaml(tempRoot, `project_id: ${VALID_UUID}\n  badly: :indented\n`);
    await expect(parseValisYaml(tempRoot)).rejects.toBeInstanceOf(
      ValisYamlError,
    );
  });

  it('warns but accepts unknown fields (forward compatibility)', async () => {
    const warn = console.warn;
    const warnings: string[] = [];
    console.warn = (...args: unknown[]) => warnings.push(String(args[0]));
    try {
      await writeYaml(
        tempRoot,
        `project_id: ${VALID_UUID}\nfuture_field: value\n`,
      );
      const result = await parseValisYaml(tempRoot);
      expect(result?.project_id).toBe(VALID_UUID);
      expect(warnings.some((w) => w.includes('future_field'))).toBe(true);
    } finally {
      console.warn = warn;
    }
  });

  it('rejects non-mapping YAML (e.g. scalar root)', async () => {
    await writeYaml(tempRoot, `just a string\n`);
    await expect(parseValisYaml(tempRoot)).rejects.toBeInstanceOf(
      ValisYamlError,
    );
  });
});
