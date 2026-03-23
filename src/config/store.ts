import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { TeamindConfig } from '../types.js';

const CONFIG_DIR = join(homedir(), '.teamind');
const CONFIG_FILE = join(CONFIG_DIR, 'config.json');

export async function loadConfig(): Promise<TeamindConfig | null> {
  try {
    const data = await readFile(CONFIG_FILE, 'utf-8');
    const raw = JSON.parse(data) as TeamindConfig;

    // Backward-compat: existing MVP configs lack auth fields.
    // Default to legacy mode so they keep working without modification.
    if (!raw.auth_mode) {
      raw.auth_mode = 'legacy';
    }
    raw.member_api_key ??= null;
    raw.member_id ??= null;

    return raw;
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

export function getConfigDir(): string {
  return CONFIG_DIR;
}

export function getConfigPath(): string {
  return CONFIG_FILE;
}
