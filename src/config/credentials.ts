import { readFile, writeFile, mkdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

const CREDENTIALS_DIR = join(homedir(), '.valis');
const CREDENTIALS_FILE = join(CREDENTIALS_DIR, 'credentials.json');

export interface ValisCredentials {
  member_api_key: string;
  member_id: string;
  author_name: string;
  org_id: string;
  org_name: string;
  supabase_url: string;
  qdrant_url: string;
}

/**
 * Save credentials to `~/.valis/credentials.json`.
 * File is created with mode 0o600 (owner read/write only).
 */
export async function saveCredentials(creds: ValisCredentials): Promise<void> {
  await mkdir(CREDENTIALS_DIR, { recursive: true, mode: 0o700 });
  await writeFile(CREDENTIALS_FILE, JSON.stringify(creds, null, 2), { mode: 0o600 });
}

/**
 * Load credentials from `~/.valis/credentials.json`.
 * Returns `null` if the file does not exist or is unreadable.
 */
export async function loadCredentials(): Promise<ValisCredentials | null> {
  try {
    const data = await readFile(CREDENTIALS_FILE, 'utf-8');
    return JSON.parse(data) as ValisCredentials;
  } catch {
    return null;
  }
}

/**
 * Remove the credentials file.
 */
export async function clearCredentials(): Promise<void> {
  try {
    await unlink(CREDENTIALS_FILE);
  } catch {
    // File may not exist — that's fine
  }
}

/**
 * Check whether valid credentials exist.
 */
export async function isLoggedIn(): Promise<boolean> {
  const creds = await loadCredentials();
  return creds !== null && !!creds.member_api_key && !!creds.member_id;
}
