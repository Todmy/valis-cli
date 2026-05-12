/**
 * Shared filesystem helpers used by all harness adapters.
 *
 * Tiny, dependency-free, side-effect-free except where stated.
 */

import { promises as fs } from 'node:fs';

export async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export async function parseJson<T = unknown>(path: string): Promise<T | undefined> {
  try {
    const content = await fs.readFile(path, 'utf-8');
    return JSON.parse(content) as T;
  } catch {
    return undefined;
  }
}

/**
 * Parse JSONC (JSON with comments). Used by OpenCode's config files which
 * are run through `jsonc-parser` upstream. We use a lightweight regex
 * stripper that handles `// line comments` and `/* block comments * /`
 * — adequate for OpenCode's config-shape, not a full JSONC implementation.
 *
 * Returns undefined on any error (missing file, malformed content).
 */
export async function parseJsonc<T = unknown>(path: string): Promise<T | undefined> {
  try {
    const raw = await fs.readFile(path, 'utf-8');
    const stripped = raw
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
    return JSON.parse(stripped) as T;
  } catch {
    return undefined;
  }
}
