import { readFile, writeFile, appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { QueueEntry, RawDecision, DecisionSource } from '../types.js';
import { randomUUID } from 'node:crypto';

const QUEUE_DIR = join(homedir(), '.valis');
const QUEUE_FILE = join(QUEUE_DIR, 'pending.jsonl');

export async function appendToQueue(
  decision: RawDecision,
  author: string,
  source: DecisionSource,
): Promise<string> {
  await mkdir(QUEUE_DIR, { recursive: true, mode: 0o700 });
  const entry: QueueEntry = {
    id: randomUUID(),
    decision,
    author,
    source,
    queued_at: new Date().toISOString(),
  };
  await appendFile(QUEUE_FILE, JSON.stringify(entry) + '\n');
  return entry.id;
}

export async function readQueue(): Promise<QueueEntry[]> {
  try {
    const data = await readFile(QUEUE_FILE, 'utf-8');
    return data
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as QueueEntry);
  } catch {
    return [];
  }
}

export async function flushQueue(): Promise<void> {
  try {
    await writeFile(QUEUE_FILE, '', { mode: 0o600 });
  } catch {
    // File doesn't exist, nothing to flush
  }
}

export async function getCount(): Promise<number> {
  const entries = await readQueue();
  return entries.length;
}
