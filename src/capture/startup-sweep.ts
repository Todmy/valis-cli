import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { loadConfig } from '../config/store.js';
import { getSupabaseClient, storeDecision } from '../cloud/supabase.js';
import { getQdrantClient, upsertDecision } from '../cloud/qdrant.js';
import { readQueue, clearQueue } from '../offline/queue.js';
import { isDuplicate, markAsSeen } from './dedup.js';

const CLAUDE_PROJECTS_DIR = join(homedir(), '.claude', 'projects');

interface SweepResult {
  processed: number;
  queued_flushed: number;
  errors: number;
}

export async function startupSweep(): Promise<SweepResult> {
  const result: SweepResult = { processed: 0, queued_flushed: 0, errors: 0 };
  const config = await loadConfig();
  if (!config) return result;

  // 1. Flush offline queue
  try {
    const queue = await readQueue();
    if (queue.length > 0) {
      const supabase = getSupabaseClient(config.supabase_url, config.supabase_service_role_key);
      const qdrant = getQdrantClient(config.qdrant_url, config.qdrant_api_key);

      for (const entry of queue) {
        try {
          const decision = await storeDecision(
            supabase,
            config.org_id,
            entry.decision,
            entry.author,
            entry.source,
            // 036/FR-003 (#90): preserve the queued status through the flush.
            // Undefined for legacy entries → storeDecision defaults to active.
            { status: entry.status },
          );
          await upsertDecision(
            qdrant,
            config.org_id,
            decision.id,
            entry.decision,
            entry.author,
            // 036/FR-003 (#90): thread the same status into the Qdrant payload
            // so the offline path doesn't flatten proposed decisions to active.
            { source: entry.source, status: entry.status },
          ).catch(() => {});
          result.queued_flushed++;
        } catch {
          result.errors++;
        }
      }

      if (result.queued_flushed > 0) {
        await clearQueue();
      }
    }
  } catch {
    // Queue flush failed, will retry later
  }

  return result;
}
