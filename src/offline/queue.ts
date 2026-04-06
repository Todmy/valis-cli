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

export async function clearQueue(): Promise<void> {
  try {
    await writeFile(QUEUE_FILE, '', { mode: 0o600 });
  } catch {
    // File doesn't exist, nothing to clear
  }
}

export async function flushQueue(
  mcpEndpoint: string,
  bearerToken: string,
): Promise<{ synced: number; failed: number; remaining: number }> {
  const entries = await readQueue();
  if (entries.length === 0) return { synced: 0, failed: 0, remaining: 0 };

  let synced = 0;
  let failed = 0;
  const remaining: QueueEntry[] = [];

  for (const entry of entries) {
    try {
      const res = await fetch(mcpEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${bearerToken}`,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: entry.id,
          method: 'tools/call',
          params: {
            name: 'valis_store',
            arguments: {
              text: entry.decision.text,
              type: entry.decision.type,
              summary: entry.decision.summary,
              affects: entry.decision.affects,
              confidence: entry.decision.confidence,
              project_id: entry.decision.project_id,
              session_id: entry.decision.session_id,
            },
          },
        }),
      });

      if (res.ok) {
        synced++;
      } else {
        failed++;
        remaining.push(entry);
      }
    } catch {
      failed++;
      remaining.push(entry);
    }
  }

  // Rewrite queue with only the failed entries
  const data = remaining.map((e) => JSON.stringify(e)).join('\n');
  await writeFile(QUEUE_FILE, data.length > 0 ? data + '\n' : '', {
    mode: 0o600,
  });

  return { synced, failed, remaining: remaining.length };
}

export async function getCount(): Promise<number> {
  const entries = await readQueue();
  return entries.length;
}
