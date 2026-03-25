import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { ValisConfig, ResolvedConfig } from '../types.js';
import { resolveConfig as resolveProjectConfig } from './project.js';

const CONFIG_DIR = join(homedir(), '.valis');
const CONFIG_FILE = join(CONFIG_DIR, 'config.json');

/**
 * Load the global config from `~/.valis/config.json`.
 * Returns `null` if the file does not exist or is unreadable.
 */
export async function loadConfig(): Promise<ValisConfig | null> {
  try {
    const data = await readFile(CONFIG_FILE, 'utf-8');
    return JSON.parse(data) as ValisConfig;
  } catch {
    return null;
  }
}

export async function saveConfig(config: ValisConfig): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
  await writeFile(CONFIG_FILE, JSON.stringify(config, null, 2), { mode: 0o600 });
}

export async function updateConfig(updates: Partial<ValisConfig>): Promise<ValisConfig> {
  const current = await loadConfig();
  if (!current) {
    throw new Error('No config found. Run `valis init` first.');
  }
  const updated = { ...current, ...updates };
  await saveConfig(updated);
  return updated;
}

/**
 * Resolve the full configuration by merging global config with per-directory
 * project config (`.valis.json` walk-up).
 *
 * Resolution states:
 * | Global | .valis.json | State          |
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
