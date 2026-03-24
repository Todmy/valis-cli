import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { TeamindConfig, ResolvedConfig } from '../types.js';
import { resolveConfig as resolveProjectConfig } from './project.js';

const CONFIG_DIR = join(homedir(), '.teamind');
const CONFIG_FILE = join(CONFIG_DIR, 'config.json');

/**
 * Load the global config from `~/.teamind/config.json`.
 * Returns `null` if the file does not exist or is unreadable.
 */
export async function loadConfig(): Promise<TeamindConfig | null> {
  try {
    const data = await readFile(CONFIG_FILE, 'utf-8');
    return JSON.parse(data) as TeamindConfig;
  } catch {
    return null;
  }
}

export async function saveConfig(config: TeamindConfig): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
  await writeFile(CONFIG_FILE, JSON.stringify(config, null, 2), { mode: 0o600 });
}

export async function updateConfig(updates: Partial<TeamindConfig>): Promise<TeamindConfig> {
  const current = await loadConfig();
  if (!current) {
    throw new Error('No config found. Run `teamind init` first.');
  }
  const updated = { ...current, ...updates };
  await saveConfig(updated);
  return updated;
}

/**
 * Resolve the full configuration by merging global config with per-directory
 * project config (`.teamind.json` walk-up).
 *
 * Resolution states:
 * | Global | .teamind.json | State          |
 * |--------|---------------|----------------|
 * | present| present       | Ready          |
 * | present| missing       | No project     |
 * | missing| present       | No org         |
 * | missing| missing       | Unconfigured   |
 *
 * @param startDir - directory to start walk-up from (defaults to cwd)
 */
export async function resolveFullConfig(startDir?: string): Promise<ResolvedConfig> {
  return resolveProjectConfig(startDir);
}

export function getConfigDir(): string {
  return CONFIG_DIR;
}

export function getConfigPath(): string {
  return CONFIG_FILE;
}
