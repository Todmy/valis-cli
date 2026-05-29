import { readFile, writeFile, appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import type { QueueEntry, RawDecision, DecisionSource } from '../types.js';
import { randomUUID } from 'node:crypto';

const PRIMARY_QUEUE_DIR = join(homedir(), '.valis');
const FALLBACK_QUEUE_DIR = join(tmpdir(), 'valis-queue');

/**
 * Resolve a writable queue dir on first use and cache it.
 *
 * Some sandboxes (Vercel Fluid Compute, restricted CI runners) report a
 * non-existent / unwritable home dir from `os.homedir()`. `mkdir
 * --recursive` cannot create missing top-level path components in those
 * environments — see BUG #143. Falling back to `os.tmpdir()` keeps the
 * offline-queue contract honest without masking real backend errors.
 *
 * Module-level cache: pay the resolution cost once per process. Reads
 * (`readQueue`/`clearQueue`) need the same resolved path so they see
 * what `appendToQueue` wrote.
 */
let cachedQueueFile: string | null = null;

async function getQueueFile(): Promise<string> {
  if (cachedQueueFile) return cachedQueueFile;
  try {
    await mkdir(PRIMARY_QUEUE_DIR, { recursive: true, mode: 0o700 });
    cachedQueueFile = join(PRIMARY_QUEUE_DIR, 'pending.jsonl');
    return cachedQueueFile;
  } catch (homeErr) {
    try {
      await mkdir(FALLBACK_QUEUE_DIR, { recursive: true, mode: 0o700 });
      console.error(
        `[queue] Home-dir queue unavailable (${(homeErr as Error).message}); falling back to ${FALLBACK_QUEUE_DIR}`,
      );
      cachedQueueFile = join(FALLBACK_QUEUE_DIR, 'pending.jsonl');
      return cachedQueueFile;
    } catch (tmpErr) {
      throw new Error(
        `Both queue dirs unwritable: home=${(homeErr as Error).message}; tmp=${(tmpErr as Error).message}`,
      );
    }
  }
}

export async function appendToQueue(
  decision: RawDecision,
  author: string,
  source: DecisionSource,
  // 036/FR-003 (#90): persist the decision's intended status so the
  // startup-sweep flush can thread it into Postgres + the Qdrant payload
  // instead of flattening proposed decisions to active. Optional + additive.
  status?: 'active' | 'proposed',
): Promise<string> {
  const queueFile = await getQueueFile();
  const entry: QueueEntry = {
    id: randomUUID(),
    decision,
    author,
    source,
    queued_at: new Date().toISOString(),
    ...(status !== undefined ? { status } : {}),
  };
  await appendFile(queueFile, JSON.stringify(entry) + '\n');
  return entry.id;
}

export async function readQueue(): Promise<QueueEntry[]> {
  try {
    const queueFile = await getQueueFile();
    const data = await readFile(queueFile, 'utf-8');
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
    const queueFile = await getQueueFile();
    await writeFile(queueFile, '', { mode: 0o600 });
  } catch {
    // File doesn't exist or queue dir unwritable — nothing to clear.
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
              // 036/FR-003 (#90): forward the persisted status. Without this,
              // the server applies `status ?? 'proposed'` on flush and an
              // explicit 'active' silently degrades to 'proposed'. Omitted
              // (not null) for legacy entries written before the status field
              // existed, so the server default still applies to them.
              ...(entry.status !== undefined ? { status: entry.status } : {}),
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
  const queueFile = await getQueueFile();
  const data = remaining.map((e) => JSON.stringify(e)).join('\n');
  await writeFile(queueFile, data.length > 0 ? data + '\n' : '', {
    mode: 0o600,
  });

  return { synced, failed, remaining: remaining.length };
}

export async function getCount(): Promise<number> {
  const entries = await readQueue();
  return entries.length;
}
