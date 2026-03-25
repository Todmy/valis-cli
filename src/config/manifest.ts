import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { Manifest, ManifestEntry } from '../types.js';

const MANIFEST_FILE = join(homedir(), '.valis', 'manifest.json');

export async function loadManifest(): Promise<Manifest> {
  try {
    const data = await readFile(MANIFEST_FILE, 'utf-8');
    return JSON.parse(data) as Manifest;
  } catch {
    return { version: '0.1.0', entries: [] };
  }
}

export async function saveManifest(manifest: Manifest): Promise<void> {
  const dir = join(homedir(), '.valis');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(MANIFEST_FILE, JSON.stringify(manifest, null, 2), { mode: 0o600 });
}

export async function trackFile(entry: Omit<ManifestEntry, 'created_at'>): Promise<void> {
  const manifest = await loadManifest();
  const exists = manifest.entries.some(
    (e) => e.type === entry.type && e.path === entry.path
  );
  if (!exists) {
    manifest.entries.push({ ...entry, created_at: new Date().toISOString() });
    await saveManifest(manifest);
  }
}
