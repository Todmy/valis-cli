/**
 * 018: `.valis.yaml` parser + CWD→repo-root walker.
 *
 * The Action and the CLI both need to locate the repo-level `.valis.yaml`
 * starting from an arbitrary CWD. We walk up the directory tree looking for
 * a `.git` marker (repo root) or a `.valis.yaml` along the way. Walk stops at
 * the first match or the filesystem root, whichever comes first — never
 * crosses above the repo boundary (consistent with how `.gitignore` is
 * resolved).
 *
 * Unknown fields pass through with a `console.warn` so future fields added
 * to the schema (e.g. `ignore_paths`, `decision_overrides`) don't break the
 * Action for repos pinned to an older parser. Breaking changes must bump the
 * file to a new name.
 */

import { readFile, stat } from 'node:fs/promises';
import { dirname, join, parse as parsePath } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import type { ValisYamlConfig } from '../types.js';

const ENFORCEMENT_MODE = z.enum(['block', 'warn', 'suggest']);

// Strict schema for v1 fields. Unknown keys are stripped by Zod; we warn
// about them explicitly in `parseValisYaml` so authors of forward-compatible
// configs see a signal rather than silent acceptance.
const ValisYamlSchema = z
  .object({
    project_id: z.string().uuid(),
    enforcement_mode: ENFORCEMENT_MODE.optional(),
  })
  .strip();

const CONFIG_FILENAME = '.valis.yaml';
const REPO_MARKER = '.git';

export class ValisYamlError extends Error {
  constructor(
    message: string,
    public readonly path: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'ValisYamlError';
  }
}

/**
 * Walk up from `cwd` looking for `.valis.yaml` or `.git`. Returns the parsed
 * config if the file was found and valid; returns `null` if no file exists
 * anywhere up to the repo root.
 *
 * Throws {@link ValisYamlError} on:
 *  - YAML syntax errors
 *  - missing/invalid `project_id` (required, must be UUID)
 *  - invalid `enforcement_mode` (must be one of the three enum values)
 */
export async function parseValisYaml(
  cwd: string,
): Promise<ValisYamlConfig | null> {
  const configPath = await findConfigFile(cwd);
  if (!configPath) return null;

  let raw: string;
  try {
    raw = await readFile(configPath, 'utf8');
  } catch (err) {
    throw new ValisYamlError(
      `Failed to read ${CONFIG_FILENAME}: ${(err as Error).message}`,
      configPath,
      err,
    );
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (err) {
    throw new ValisYamlError(
      `Malformed YAML in ${CONFIG_FILENAME}: ${(err as Error).message}`,
      configPath,
      err,
    );
  }

  if (parsed === null || typeof parsed !== 'object') {
    throw new ValisYamlError(
      `${CONFIG_FILENAME} must be a YAML mapping, got ${typeof parsed}`,
      configPath,
    );
  }

  const result = ValisYamlSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    throw new ValisYamlError(
      `Invalid ${CONFIG_FILENAME}: ${issues}`,
      configPath,
    );
  }

  // Warn on unknown keys so authors of forward-compatible configs see drift.
  const known = new Set(['project_id', 'enforcement_mode']);
  for (const key of Object.keys(parsed as Record<string, unknown>)) {
    if (!known.has(key)) {
      console.warn(
        `[valis] Unknown field \`${key}\` in ${configPath} — ignored (may be a future-version field).`,
      );
    }
  }

  return result.data;
}

/**
 * Walk from `cwd` up to the filesystem root. Return the first path at which
 * `.valis.yaml` exists. Stop the walk once we cross a `.git` boundary so we
 * do not pick up a config from an enclosing repo.
 */
async function findConfigFile(cwd: string): Promise<string | null> {
  let dir = cwd;
  const root = parsePath(dir).root;

  while (true) {
    const configPath = join(dir, CONFIG_FILENAME);
    if (await pathExists(configPath)) {
      return configPath;
    }

    // If we hit a repo root and there was no config here, stop — don't
    // escape out of the repo.
    const gitPath = join(dir, REPO_MARKER);
    if (await pathExists(gitPath)) {
      return null;
    }

    if (dir === root) return null;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
