import pc from 'picocolors';
import { loadConfig, updateConfig } from '../config/store.js';
import type { TeamindConfig } from '../types.js';

const WRITABLE_KEYS = ['api-key', 'author-name'] as const;
const READ_ONLY_KEYS = ['org-id'] as const;
const ALL_KEYS = [...WRITABLE_KEYS, ...READ_ONLY_KEYS] as const;

type ConfigKey = (typeof ALL_KEYS)[number];

const KEY_TO_FIELD: Record<string, keyof TeamindConfig> = {
  'api-key': 'api_key',
  'author-name': 'author_name',
  'org-id': 'org_id',
};

export async function configGetCommand(key: string): Promise<void> {
  const config = await loadConfig();
  if (!config) {
    console.error('Error: Teamind not configured. Run `teamind init` first.');
    process.exit(1);
  }

  if (!ALL_KEYS.includes(key as ConfigKey)) {
    console.error(`Unknown key: ${key}. Valid keys: ${ALL_KEYS.join(', ')}`);
    process.exit(1);
  }

  const field = KEY_TO_FIELD[key];
  const value = String(config[field]);

  if (key === 'api-key') {
    console.log(value.substring(0, 6) + '...' + value.substring(value.length - 4));
  } else {
    console.log(value);
  }
}

export async function configSetCommand(key: string, value: string): Promise<void> {
  if (!WRITABLE_KEYS.includes(key as (typeof WRITABLE_KEYS)[number])) {
    if (READ_ONLY_KEYS.includes(key as (typeof READ_ONLY_KEYS)[number])) {
      console.error(`${key} is read-only. Use \`teamind init\` to change it.`);
    } else {
      console.error(`Unknown key: ${key}. Writable keys: ${WRITABLE_KEYS.join(', ')}`);
    }
    process.exit(1);
  }

  const field = KEY_TO_FIELD[key];
  const update: Partial<TeamindConfig> = { [field]: value };
  await updateConfig(update);
  console.log(pc.green(`\u2713 ${key} updated`));
}
