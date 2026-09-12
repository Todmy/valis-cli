import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('standalone TypeScript configuration', () => {
  it('resolves its base config inside the public package checkout', async () => {
    const tsconfig = await readFile(join(root, 'tsconfig.json'), 'utf8');
    expect(tsconfig).toContain('"extends": "./tsconfig.base.json"');
    await expect(readFile(join(root, 'tsconfig.base.json'), 'utf8')).resolves.toContain('"module": "NodeNext"');
  });
});
