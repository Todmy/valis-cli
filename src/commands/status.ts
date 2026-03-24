import pc from 'picocolors';
import { loadConfig } from '../config/store.js';
import { resolveConfig } from '../config/project.js';
import { getSupabaseClient, healthCheck as supabaseHealth, getOrgInfo, getProjectDecisionCount } from '../cloud/supabase.js';
import { getQdrantClient, healthCheck as qdrantHealth } from '../cloud/qdrant.js';
import { getCount as getQueueCount } from '../offline/queue.js';
import type { AuthMode } from '../types.js';

// ---------------------------------------------------------------------------
// T020: Realtime connection status (shared with serve command)
// ---------------------------------------------------------------------------

export type RealtimeStatus = 'connected' | 'disconnected' | 'degraded';

/** Module-level realtime status — set by the serve command's subscription. */
let currentRealtimeStatus: RealtimeStatus = 'disconnected';

/** Module-level realtime project name — set by serve command. */
let currentRealtimeProject: string | null = null;

/** Update the realtime status (called from serve.ts on status changes). */
export function setRealtimeStatus(status: RealtimeStatus): void {
  currentRealtimeStatus = status;
}

/** Get the current realtime status. */
export function getRealtimeStatus(): RealtimeStatus {
  return currentRealtimeStatus;
}

/** Update the realtime project name (called from serve.ts). */
export function setRealtimeProject(projectName: string | null): void {
  currentRealtimeProject = projectName;
}

// ---------------------------------------------------------------------------
// Status command
// ---------------------------------------------------------------------------

export async function statusCommand(): Promise<void> {
  // T034: Resolve both global and project config
  const resolved = await resolveConfig();
  const config = resolved.global;
  const projectConfig = resolved.project;

  // T036: Handle all four resolution states from contracts/config.md
  if (!config && !projectConfig) {
    // State: unconfigured
    console.log(pc.bold('\nTeamind Status\n'));
    console.log(`  ${pc.red('Unconfigured')}`);
    console.log(pc.dim('\n  Run `teamind init` to get started.\n'));
    process.exit(1);
  }

  if (!config && projectConfig) {
    // State: no-org (.teamind.json exists but no global config)
    console.log(pc.bold('\nTeamind Status\n'));
    console.log(`  Project: ${pc.green(projectConfig.project_name)} (from .teamind.json)`);
    console.log(`  Org: ${pc.red('(not configured)')}`);
    console.log(pc.dim('\n  Run `teamind init` to configure credentials.\n'));
    process.exit(1);
  }

  // At this point config is guaranteed non-null
  // (TypeScript needs the assertion after the process.exit guard)
  if (!config) {
    process.exit(1);
    return; // unreachable — helps TS narrow
  }

  console.log(pc.bold('\nTeamind Status\n'));

  // Org info (always show)
  console.log(`  Org:      ${config.org_name}`);

  // T035: Show project name, project_id, project role
  if (projectConfig) {
    console.log(`  Project:  ${pc.green(projectConfig.project_name)} (active)`);
  } else {
    // State: no-project (T036)
    console.log(`  Project:  ${pc.yellow('(not configured)')}`);
  }

  // Author
  console.log(`  Author:   ${config.author_name}`);

  // Auth mode (T020)
  const authMode: AuthMode = config.auth_mode ?? 'legacy';
  if (authMode === 'jwt') {
    console.log(`  Auth:     ${pc.green('jwt')} (per-member)`);
  } else {
    console.log(`  Auth:     ${pc.yellow('legacy')} (org-level key)`);
  }

  // Cloud connectivity
  const supabase = getSupabaseClient(config.supabase_url, config.supabase_service_role_key);
  const qdrant = getQdrantClient(config.qdrant_url, config.qdrant_api_key);

  const [pgOk, qOk] = await Promise.all([
    supabaseHealth(supabase),
    qdrantHealth(qdrant),
  ]);

  if (pgOk && qOk) {
    console.log(`  Cloud:    ${pc.green('OK')} (Supabase + Qdrant)`);
  } else if (pgOk || qOk) {
    console.log(`  Cloud:    ${pc.yellow('Degraded')} (${!pgOk ? 'Supabase' : 'Qdrant'} down)`);
  } else {
    console.log(`  Cloud:    ${pc.red('Offline')}`);
  }

  // Realtime connection status — T035: include project name when connected
  const rtStatus = getRealtimeStatus();
  switch (rtStatus) {
    case 'connected': {
      const projectLabel = currentRealtimeProject
        ? ` (project: ${currentRealtimeProject})`
        : projectConfig
          ? ` (project: ${projectConfig.project_name})`
          : '';
      console.log(`  Realtime: ${pc.green('connected')}${projectLabel}`);
      break;
    }
    case 'degraded':
      console.log(`  Realtime: ${pc.yellow('degraded')}`);
      break;
    case 'disconnected':
      console.log(`  Realtime: ${pc.red('disconnected')}`);
      break;
  }

  // Brain: project-scoped decision count (T034)
  if (pgOk && projectConfig) {
    try {
      const count = await getProjectDecisionCount(supabase, config.org_id, projectConfig.project_id);
      console.log(`  Brain:    ${count} decisions in this project`);
    } catch {
      // Fall back to org-level count
      const info = await getOrgInfo(supabase, config.org_id);
      if (info) {
        console.log(`  Brain:    ${info.decision_count} decisions (org-wide)`);
      }
    }
  } else if (pgOk) {
    const info = await getOrgInfo(supabase, config.org_id);
    if (info) {
      console.log(`  Brain:    ${info.decision_count} decisions`);
    }
  }

  // Queue
  const queueCount = await getQueueCount();
  if (queueCount > 0) {
    console.log(`  Queue:    ${pc.yellow(`${queueCount} awaiting sync`)}`);
  } else {
    console.log(`  Queue:    ${pc.green('0 pending')}`);
  }

  // IDEs
  const ides = config.configured_ides;
  if (ides.length > 0) {
    console.log(`  IDEs:     ${ides.map((i) => `${i} ${pc.green('✓')}`).join(', ')}`);
  } else {
    console.log(`  IDEs:     ${pc.yellow('none configured')}`);
  }

  // T036: No-project hint at the bottom
  if (!projectConfig) {
    console.log(pc.dim('\n  Run `teamind init` in your project directory to select a project.'));
  }

  console.log();
}
