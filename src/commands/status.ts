import pc from 'picocolors';
import { loadConfig } from '../config/store.js';
import { getSupabaseClient, healthCheck as supabaseHealth, getOrgInfo } from '../cloud/supabase.js';
import { getQdrantClient, healthCheck as qdrantHealth } from '../cloud/qdrant.js';
import { getCount as getQueueCount } from '../offline/queue.js';
import type { AuthMode } from '../types.js';

// ---------------------------------------------------------------------------
// T020: Realtime connection status (shared with serve command)
// ---------------------------------------------------------------------------

export type RealtimeStatus = 'connected' | 'disconnected' | 'degraded';

/** Module-level realtime status — set by the serve command's subscription. */
let currentRealtimeStatus: RealtimeStatus = 'disconnected';

/** Update the realtime status (called from serve.ts on status changes). */
export function setRealtimeStatus(status: RealtimeStatus): void {
  currentRealtimeStatus = status;
}

/** Get the current realtime status. */
export function getRealtimeStatus(): RealtimeStatus {
  return currentRealtimeStatus;
}

// ---------------------------------------------------------------------------
// Status command
// ---------------------------------------------------------------------------

export async function statusCommand(): Promise<void> {
  const config = await loadConfig();
  if (!config) {
    console.error('Error: Teamind not configured. Run `teamind init` first.');
    process.exit(1);
  }

  console.log(pc.bold('\nTeamind Status\n'));

  // Cloud connectivity
  const supabase = getSupabaseClient(config.supabase_url, config.supabase_service_role_key);
  const qdrant = getQdrantClient(config.qdrant_url, config.qdrant_api_key);

  const [pgOk, qOk] = await Promise.all([
    supabaseHealth(supabase),
    qdrantHealth(qdrant),
  ]);

  if (pgOk && qOk) {
    console.log(`  Cloud: ${pc.green('● Connected')}`);
  } else if (pgOk || qOk) {
    console.log(`  Cloud: ${pc.yellow('○ Degraded')} (${!pgOk ? 'Supabase' : 'Qdrant'} down)`);
  } else {
    console.log(`  Cloud: ${pc.red('✕ Offline')}`);
  }

  // Realtime connection status (T020)
  const rtStatus = getRealtimeStatus();
  switch (rtStatus) {
    case 'connected':
      console.log(`  Realtime: ${pc.green('● Connected')}`);
      break;
    case 'degraded':
      console.log(`  Realtime: ${pc.yellow('○ Degraded')}`);
      break;
    case 'disconnected':
      console.log(`  Realtime: ${pc.red('✕ Disconnected')}`);
      break;
  }

  // Auth mode (T020)
  const authMode: AuthMode = config.auth_mode ?? 'legacy';
  if (authMode === 'jwt') {
    console.log(`  Auth: ${pc.green('jwt')} (per-member keys)`);
  } else {
    console.log(`  Auth: ${pc.yellow('legacy')} (org-level key)`);
  }

  // Org info
  if (pgOk) {
    const info = await getOrgInfo(supabase, config.org_id);
    if (info) {
      console.log(`  Org: ${info.name} (${info.member_count} members)`);
      console.log(`  Decisions: ${info.decision_count}`);
    }
  } else {
    console.log(`  Org: ${config.org_name}`);
  }

  // Queue
  const queueCount = await getQueueCount();
  if (queueCount > 0) {
    console.log(`  Queue: ${pc.yellow(`${queueCount} awaiting sync`)}`);
  } else {
    console.log(`  Queue: ${pc.green('0 pending')}`);
  }

  // IDEs
  const ides = config.configured_ides;
  if (ides.length > 0) {
    console.log(`  IDEs: ${ides.map((i) => `${i} ${pc.green('✓')}`).join(', ')}`);
  } else {
    console.log(`  IDEs: ${pc.yellow('none configured')}`);
  }

  console.log();
}
