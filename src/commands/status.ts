import pc from 'picocolors';
import { loadConfig } from '../config/store.js';
import { resolveConfig } from '../config/project.js';
import { getSupabaseClient, healthCheck as supabaseHealth, getOrgInfo, getProjectDecisionCount } from '../cloud/supabase.js';
import { getQdrantClient, healthCheck as qdrantHealth } from '../cloud/qdrant.js';
import { getCount as getQueueCount } from '../offline/queue.js';
import { loadConsent } from '../hooks/consent.js';
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

export interface StatusOptions {
  telemetry?: boolean;
}

export async function statusCommand(options: StatusOptions = {}): Promise<void> {
  // Feature 023 US4: --telemetry flag short-circuits to consent + transmission
  // visibility. Engineer-facing audit surface.
  if (options.telemetry) {
    await statusTelemetryCommand();
    return;
  }

  // T034: Resolve both global and project config
  const resolved = await resolveConfig();
  const config = resolved.global;
  const projectConfig = resolved.project;

  // T036: Handle all four resolution states from contracts/config.md
  if (!config && !projectConfig) {
    // State: unconfigured
    console.log(pc.bold('\nValis Status\n'));
    console.log(`  ${pc.red('Unconfigured')}`);
    console.log(pc.dim('\n  Run `valis init` to get started.\n'));
    process.exit(1);
  }

  if (!config && projectConfig) {
    // State: no-org (.valis.json exists but no global config)
    console.log(pc.bold('\nValis Status\n'));
    console.log(`  Project: ${pc.green(projectConfig.project_name)} (from .valis.json)`);
    console.log(`  Org: ${pc.red('(not configured)')}`);
    console.log(pc.dim('\n  Run `valis init` to configure credentials.\n'));
    process.exit(1);
  }

  // At this point config is guaranteed non-null
  // (TypeScript needs the assertion after the process.exit guard)
  if (!config) {
    process.exit(1);
    return; // unreachable — helps TS narrow
  }

  console.log(pc.bold('\nValis Status\n'));

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
  const isHostedMode = !config.supabase_service_role_key;
  let pgOk = false;
  let qOk = false;

  if (isHostedMode) {
    // Hosted mode: check API proxy instead of direct connections
    try {
      const apiUrl = (await import('../types.js')).HOSTED_API_URL;
      const res = await fetch(`${apiUrl}/api/check-usage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.member_api_key || config.api_key}` },
        body: JSON.stringify({ org_id: config.org_id }),
      });
      pgOk = res.status !== 500;
      qOk = pgOk; // Qdrant proxied through API
    } catch {
      // offline
    }
    if (pgOk) {
      console.log(`  Cloud:    ${pc.green('OK')} (hosted mode)`);
    } else {
      console.log(`  Cloud:    ${pc.red('Offline')} (cannot reach valis.krukit.co)`);
    }
  } else {
    const supabase = getSupabaseClient(config.supabase_url, config.supabase_service_role_key);
    const qdrant = getQdrantClient(config.qdrant_url, config.qdrant_api_key);

    [pgOk, qOk] = await Promise.all([
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
  if (pgOk && projectConfig && !isHostedMode) {
    try {
      const sb = getSupabaseClient(config.supabase_url, config.supabase_service_role_key);
      const count = await getProjectDecisionCount(sb, config.org_id, projectConfig.project_id);
      console.log(`  Brain:    ${count} decisions in this project`);
    } catch {
      try {
        const sb = getSupabaseClient(config.supabase_url, config.supabase_service_role_key);
        const info = await getOrgInfo(sb, config.org_id);
        if (info) {
          console.log(`  Brain:    ${info.decision_count} decisions (org-wide)`);
        }
      } catch { /* skip */ }
    }
  } else if (pgOk && isHostedMode) {
    console.log(`  Brain:    ${pc.dim('Use valis search to query decisions')}`);
  } else if (pgOk && !isHostedMode) {
    try {
      const sb = getSupabaseClient(config.supabase_url, config.supabase_service_role_key);
      const info = await getOrgInfo(sb, config.org_id);
      if (info) {
        console.log(`  Brain:    ${info.decision_count} decisions`);
      }
    } catch { /* skip */ }
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
    console.log(pc.dim('\n  Run `valis init` in your project directory to select a project.'));
  }

  console.log();
}

// ---------------------------------------------------------------------------
// Feature 023 US4 — `valis status --telemetry`
// ---------------------------------------------------------------------------

async function statusTelemetryCommand(): Promise<void> {
  console.log(pc.bold('\nValis Telemetry Status\n'));
  const consent = await loadConsent();
  if (!consent) {
    console.log(`  ${pc.yellow('No consent record yet.')}`);
    console.log(pc.dim('  Run `valis init` to set up telemetry consent.\n'));
    return;
  }
  console.log(`  installation_id      ${consent.installation_id}`);
  console.log(
    `  consent_state        ${stateColor(consent.consent_state)}${consent.consent_state}${pc.reset('')}`,
  );
  console.log(`  transmission_active  ${consent.transmission_active ? pc.green('yes') : pc.red('no')}`);
  console.log(`  is_self_hosted       ${consent.is_self_hosted ? 'yes' : 'no'}`);
  console.log(`  consent_decided_at   ${consent.consent_decided_at}`);
  console.log(`  day_30_anniversary   ${consent.day_30_anniversary}`);
  const days =
    (Date.parse(consent.day_30_anniversary) - Date.now()) / (24 * 3600 * 1000);
  if (consent.consent_state === 'accepted_30day_window') {
    if (days > 0) {
      console.log(pc.dim(`  ${Math.ceil(days)} day(s) until day-30 prompt fires.`));
    } else {
      console.log(pc.yellow('  Day-30 anniversary reached — next CLI invocation will prompt.'));
    }
  }

  // Feature 023 US3 (T039) — migration audit summary for the active project.
  await reportMigrationStatus();

  console.log(pc.dim('\n  Toggle: `valis config set telemetry on|off`\n'));
}

async function reportMigrationStatus(): Promise<void> {
  const { resolveConfig } = await import('../config/project.js');
  const { loadManifest } = await import('../hooks/migration.js');
  const resolved = await resolveConfig();
  const project = resolved.project;
  if (!project?.project_id) return;

  try {
    const manifest = await loadManifest(project.project_id);
    const migrated = manifest.migrations.length;
    const declined = manifest.decline_history.length;
    if (migrated === 0 && declined === 0) return;
    console.log('');
    console.log(`  Migration (${project.project_name})`);
    console.log(`    accepted    ${migrated} entr${migrated === 1 ? 'y' : 'ies'}`);
    console.log(`    declined    ${declined} entr${declined === 1 ? 'y' : 'ies'}`);
    if (manifest.migrations.length > 0) {
      const last = manifest.migrations[manifest.migrations.length - 1];
      console.log(pc.dim(`    last        ${last.migrated_at} (${last.source_path})`));
    }
  } catch {
    /* best-effort */
  }
}

function stateColor(state: string): string {
  if (state.startsWith('accepted_')) return pc.green('');
  if (state === 'pending') return pc.yellow('');
  return pc.red('');
}
