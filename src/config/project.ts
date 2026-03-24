/**
 * Per-directory project config resolution.
 *
 * Implements the walk-up algorithm from contracts/config.md:
 * - Start at a given directory (typically cwd)
 * - Walk up looking for `.teamind.json`
 * - First match wins (closest to startDir)
 * - Returns null if no `.teamind.json` found
 *
 * @module config/project
 */

import { readFile, writeFile } from 'node:fs/promises';
import { join, parse, dirname } from 'node:path';
import { z } from 'zod';
import type { ProjectConfig, ResolvedConfig } from '../types.js';
import { loadConfig } from './store.js';

// ---------------------------------------------------------------------------
// Zod schema for .teamind.json validation
// ---------------------------------------------------------------------------

export const projectConfigSchema = z.object({
  project_id: z.string().uuid(),
  project_name: z.string().min(1).max(100),
});

// ---------------------------------------------------------------------------
// Walk-up algorithm
// ---------------------------------------------------------------------------

/**
 * Walk up from `startDir` to the filesystem root looking for `.teamind.json`.
 * Returns the path to the first match, or null if none found.
 */
export async function findProjectConfigPath(startDir: string): Promise<string | null> {
  let dir = startDir;
  const root = parse(dir).root; // '/' on Unix, 'C:\' on Windows

  while (true) {
    const configPath = join(dir, '.teamind.json');
    try {
      await readFile(configPath, 'utf-8');
      return configPath;
    } catch {
      // File not found — walk up
    }

    const parent = dirname(dir);
    if (parent === dir || dir === root) {
      return null;
    }
    dir = parent;
  }
}

/**
 * Walk up from `startDir` to the filesystem root looking for `.teamind.json`.
 * Returns the parsed and validated ProjectConfig, or null if not found.
 */
export async function findProjectConfig(startDir: string): Promise<ProjectConfig | null> {
  const configPath = await findProjectConfigPath(startDir);
  if (!configPath) return null;
  return loadProjectConfig(configPath);
}

/**
 * Load and validate a `.teamind.json` file at the given path.
 * Throws on invalid JSON or schema validation failure.
 */
export async function loadProjectConfig(configPath: string): Promise<ProjectConfig> {
  const data = await readFile(configPath, 'utf-8');
  const parsed = JSON.parse(data);
  const result = projectConfigSchema.safeParse(parsed);
  if (!result.success) {
    const firstIssue = result.error.issues[0];
    throw new Error(
      `Invalid .teamind.json — ${firstIssue?.path.join('.')}: ${firstIssue?.message}.\n` +
        `  Fix the file at ${configPath} or run \`teamind init\` to reconfigure.`,
    );
  }
  return result.data;
}

/**
 * Write a `.teamind.json` file to the given directory.
 */
export async function writeProjectConfig(
  targetDir: string,
  config: ProjectConfig,
): Promise<string> {
  const configPath = join(targetDir, '.teamind.json');
  await writeFile(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
  return configPath;
}

/**
 * Resolve the full config by combining global config with per-directory
 * project config. Returns a ResolvedConfig with both (either can be null).
 */
export async function resolveConfig(startDir?: string): Promise<ResolvedConfig> {
  const global = await loadConfig();
  const project = await findProjectConfig(startDir ?? process.cwd());
  return { global, project };
}
