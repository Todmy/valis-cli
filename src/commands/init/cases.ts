/**
 * `initCommand` case handlers — one function per (existing state, user
 * intent) branch. The dispatcher in `../init.ts` decides which to run; this
 * file owns the linear flow for each.
 *
 * Five cases mirror the original mega-function's structure:
 *   - runLoggedInPath        — Case A (fast path: `valis login` already done)
 *   - runJoinFlow            — Case B (--join <code>: invite-based join)
 *   - runReconfigure         — Case C (both global + project config exist)
 *   - runLegacyMigration     — Case D (global config but no .valis.json)
 *   - runFreshInstall        — Case E (fresh install, asks setup mode)
 *
 * Each case is self-contained: it loads what it needs, prompts what it needs,
 * writes config files, and prints its own summary. The dispatcher never
 * touches per-case state.
 */

import { basename } from 'node:path';
import select from '@inquirer/select';
import input from '@inquirer/input';
import pc from 'picocolors';
import { loadConfig, saveConfig, getConfigDir } from '../../config/store.js';
import { findProjectConfig, writeProjectConfig } from '../../config/project.js';
import { trackFile } from '../../config/manifest.js';
import { runHostedSeed } from '../../seed/index.js';
import { getSupabaseClient, listMemberProjects, joinProject } from '../../cloud/supabase.js';
import { assertSchemaCompatible } from '../../cloud/schema-guard.js';
import { getQdrantClient, countLegacyPoints } from '../../cloud/qdrant.js';
import { register, joinPublic } from '../../cloud/registration.js';
import { loadCredentials } from '../../config/credentials.js';
import type { ValisConfig, ProjectConfig } from '../../types.js';
import { HOSTED_SUPABASE_URL } from '../../types.js';
import { emitAdoptionEvents } from '../../lib/adoption-emit.js';
import {
  prompt,
  createOrg,
  promptAndCreateProject,
  selectOrCreateProject,
  setupIDEs,
  setupQdrant,
  seedAndVerify,
  selectOrCreateProjectLoggedIn,
  detectCompetingHooks,
  printSummary,
  runMemoryMigration,
  runTelemetryConsent,
} from './helpers.js';
import type { InitOptions } from '../init.js';

type SetupMode = 'hosted' | 'community';

export type ReconfigureOutcome = 'switched' | 'reset' | 'cancelled';
export type FreshInstallOutcome = 'completed' | 'needs_retry';

// ===========================================================================
// Case A — fast path for users already logged in via `valis login`
// ===========================================================================

export async function runLoggedInPath(options: InitOptions = {}): Promise<void> {
  const creds = (await loadCredentials())!;
  console.log(pc.green(`Logged in as ${creds.author_name} (${creds.org_name})\n`));

  const existingCfg = await loadConfig();
  const existingProj = await findProjectConfig(process.cwd());

  // If already configured for this directory, offer switch/reset
  if (existingCfg && existingProj) {
    console.log(pc.yellow('Valis is already configured for this directory.'));
    console.log(`  Org: ${existingCfg.org_name}`);
    console.log(`  Project: ${existingProj.project_name}`);
    console.log('');
    const answer = await select({
      message: 'What would you like to do?',
      choices: [
        { name: 'Switch project', value: 'switch' },
        { name: 'Reconfigure (full reset)', value: 'reset' },
        { name: 'Cancel', value: 'cancel' },
      ],
    });

    if (answer === 'switch') {
      const projectConfig = await selectOrCreateProjectLoggedIn(creds, options);
      const configPath = await writeProjectConfig(process.cwd(), projectConfig);
      console.log(pc.green(`✓ Project config updated: ${configPath}`));
      console.log(`  Project: ${pc.cyan(projectConfig.project_name)}`);
      return;
    } else if (answer === 'cancel') {
      console.log('Aborted.');
      return;
    }
    // 'reset' falls through to project selection below
  }

  // Select or create a project using credentials
  const projectConfig = await selectOrCreateProjectLoggedIn(creds, options);

  // Build a ValisConfig for the global config file
  const config: ValisConfig = {
    org_id: creds.org_id,
    org_name: creds.org_name,
    api_key: '',
    invite_code: (projectConfig as unknown as Record<string, string>).invite_code || '',
    author_name: creds.author_name,
    supabase_url: creds.supabase_url || HOSTED_SUPABASE_URL,
    supabase_service_role_key: '',
    qdrant_url: creds.qdrant_url || '',
    qdrant_api_key: '',
    configured_ides: existingCfg?.configured_ides || [],
    created_at: existingCfg?.created_at || new Date().toISOString(),
    member_api_key: creds.member_api_key,
    member_id: creds.member_id,
    auth_mode: 'jwt' as const,
  };

  await saveConfig(config);
  await trackFile({ type: 'config_dir', path: getConfigDir() });
  console.log(pc.green('✓ Config saved'));

  const projectConfigPath = await writeProjectConfig(process.cwd(), projectConfig);
  console.log(pc.green(`✓ Project config saved to ${projectConfigPath}`));

  // Configure IDEs
  const detectedNames = await setupIDEs(config);
  config.configured_ides = detectedNames;
  await saveConfig(config);

  // Seed via hosted API
  console.log(pc.cyan('\nSeeding team brain (via hosted API)...'));
  try {
    const seedResult = await runHostedSeed(
      process.cwd(),
      config.supabase_url,
      config.member_api_key || config.api_key,
      projectConfig.project_id,
    );
    if (seedResult.stored > 0) {
      console.log(pc.green(`✓ Seeded ${seedResult.stored} decisions from ${Object.keys(seedResult.sources).join(', ') || 'sources'}`));
    } else if (seedResult.total === 0) {
      console.log(pc.dim('  No decisions found to seed (empty CLAUDE.md/AGENTS.md/git history).'));
    } else {
      console.log(pc.yellow(`⚠ Seed: ${seedResult.skipped} decisions skipped (duplicates or errors).`));
    }
  } catch (err) {
    console.log(pc.yellow(`⚠ Seed skipped: ${(err as Error).message}`));
  }

  await printSummary(config, projectConfig, false);
}

// ===========================================================================
// Case B — --join <invite-code>
// ===========================================================================
//
// Hosted mode (no existing config or no service_role_key): call
// joinPublic() — a public endpoint that requires no pre-existing
// credentials. The response includes supabase_url, qdrant_url, and
// member_api_key — everything the CLI needs to configure from scratch.
//
// Community / existing config with service_role_key: use joinProject()
// with the already-known supabase_url.

export async function runJoinFlow(joinCode: string, existing: ValisConfig | null): Promise<void> {
  console.log(pc.cyan(`\nJoining project with invite code: ${joinCode}`));
  const authorName = await prompt('Your name: ');

  let projectConfig: ProjectConfig | undefined;
  let config: ValisConfig;

  // Hosted: no existing config, or existing config has no service_role_key.
  const useHostedJoin = !existing || !existing.supabase_service_role_key;

  if (useHostedJoin) {
    // ------------------------------------------------------------------
    // Hosted join: call the public joinPublic() endpoint.
    // No credentials needed — the response provides everything.
    // ------------------------------------------------------------------
    const supabaseUrl = existing?.supabase_url || HOSTED_SUPABASE_URL;

    try {
      const result = await joinPublic(joinCode, authorName, supabaseUrl);
      console.log(pc.green(`✓ Joined project "${result.project_name}" in org "${result.org_name}"`));
      console.log(`  ${result.decision_count} decisions already available`);

      projectConfig = {
        project_id: result.project_id,
        project_name: result.project_name,
      };

      // Save config with member_api_key only — no service_role_key
      config = {
        org_id: result.org_id,
        org_name: result.org_name,
        api_key: '', // not available via public join
        invite_code: joinCode,
        author_name: authorName,
        supabase_url: result.supabase_url,
        supabase_service_role_key: '', // not needed for hosted mode
        qdrant_url: result.qdrant_url,
        qdrant_api_key: result.qdrant_api_key || '', // read-only key for hosted search
        configured_ides: existing?.configured_ides || [],
        created_at: new Date().toISOString(),
        member_api_key: result.member_api_key,
        member_id: result.member_id,
        auth_mode: 'jwt' as const, // hosted mode always uses JWT
      };
      await saveConfig(config);
      await trackFile({ type: 'config_dir', path: getConfigDir() });
      console.log(pc.green('✓ Global config saved'));
    } catch (err) {
      console.log(pc.red(`\n${(err as Error).message}`));
      return;
    }
  } else {
    // ------------------------------------------------------------------
    // Community / existing config: use joinProject() with known URL
    // ------------------------------------------------------------------
    try {
      const result = await joinProject(existing.supabase_url, joinCode, authorName);
      console.log(pc.green(`✓ Joined project "${result.project_name}" in org "${result.org_name}"`));

      projectConfig = {
        project_id: result.project_id,
        project_name: result.project_name,
      };

      if (existing.org_id !== result.org_id) {
        config = {
          org_id: result.org_id,
          org_name: result.org_name,
          api_key: result.api_key || '',
          invite_code: joinCode,
          author_name: authorName,
          supabase_url: result.supabase_url || existing.supabase_url,
          supabase_service_role_key: existing.supabase_service_role_key,
          qdrant_url: result.qdrant_url || existing.qdrant_url,
          qdrant_api_key: existing.qdrant_api_key,
          configured_ides: existing.configured_ides || [],
          created_at: new Date().toISOString(),
          member_api_key: result.member_api_key || null,
          member_id: result.member_id || null,
        };
        await saveConfig(config);
        await trackFile({ type: 'config_dir', path: getConfigDir() });
        console.log(pc.green('✓ Global config saved'));
      } else {
        config = existing;
        console.log(pc.dim('  Global config unchanged (same org)'));
      }
    } catch (err) {
      console.log(pc.red(`\n${(err as Error).message}`));
      return;
    }
  }

  // Write .valis.json
  if (projectConfig) {
    const configPath = await writeProjectConfig(process.cwd(), projectConfig);
    console.log(pc.green(`✓ Project config saved to ${configPath}`));
  }

  // Configure IDEs if not already configured
  if (!existing || existing.configured_ides.length === 0) {
    const detectedNames = await setupIDEs(config);
    config.configured_ides = detectedNames;
    await saveConfig(config);
  }

  if (projectConfig) {
    await printSummary(config, projectConfig, true);
  }
}

// ===========================================================================
// Case C — both global config and .valis.json exist
// ===========================================================================
//
// Returns 'switched' (project changed; done), 'reset' (user wants full
// reset; dispatcher should fall through to fresh install), or 'cancelled'
// (user aborted; done).

export async function runReconfigure(
  existing: ValisConfig,
  existingProject: ProjectConfig,
): Promise<ReconfigureOutcome> {
  console.log(pc.yellow('Valis is already configured for this directory.'));
  console.log(`  Org: ${existing.org_name}`);
  console.log(`  Project: ${existingProject.project_name}`);
  console.log(`  Author: ${existing.author_name}`);
  console.log('');
  const answer = await select({
    message: 'What would you like to do?',
    choices: [
      { name: 'Switch project', value: 'switch' },
      { name: 'Reconfigure org (full reset)', value: 'reset' },
      { name: 'Cancel', value: 'cancel' },
    ],
  });

  if (answer === 'switch') {
    const projectConfig = await selectOrCreateProject(
      existing.supabase_url,
      existing.supabase_service_role_key,
      existing.api_key,
      existing.org_id,
      existing.member_id || null,
    );
    const configPath = await writeProjectConfig(process.cwd(), projectConfig);
    console.log(pc.green(`✓ Project config updated: ${configPath}`));
    console.log(`  Project: ${pc.cyan(projectConfig.project_name)}`);
    return 'switched';
  } else if (answer === 'cancel') {
    console.log('Aborted.');
    return 'cancelled';
  }
  // 'reset' — dispatcher falls through to fresh install
  return 'reset';
}

// ===========================================================================
// Case D — global config exists but no .valis.json (legacy migration path)
// ===========================================================================
//
// T038 (US6): When an upgraded CLI detects global config but no
// .valis.json, this is a legacy installation that was configured
// before multi-project support. We try to find the default project
// and write .valis.json automatically, or fall through to the
// standard project selection flow.

export async function runLegacyMigration(existing: ValisConfig): Promise<void> {
  console.log(pc.yellow('Config found but no project selected for this directory.'));
  console.log(pc.green(`  Org: ${existing.org_name}`));
  console.log(pc.green(`  Author: ${existing.author_name}\n`));

  let projectConfig: ProjectConfig | undefined;

  const isHostedMode = !existing.supabase_service_role_key;

  if (isHostedMode) {
    // Hosted mode: use idempotent register endpoint to create/find project
    const projectName = await input({ message: 'Project name:', default: basename(process.cwd()) });
    try {
      const regResult = await register(existing.org_name, projectName, existing.author_name, existing.supabase_url);
      projectConfig = {
        project_id: regResult.project_id,
        project_name: regResult.project_name,
      };
      console.log(pc.green(`✓ Project "${regResult.project_name}" ready`));
    } catch (err) {
      console.log(pc.red(`Error: ${(err as Error).message}`));
      return;
    }
  } else {
    // Community mode: use direct Supabase access
    if (existing.member_id) {
      try {
        const supabase = getSupabaseClient(
          existing.supabase_url,
          existing.supabase_service_role_key,
        );
        const projects = await listMemberProjects(supabase, existing.member_id);
        const defaultProject = projects.find((p) => p.name === 'default');

        if (defaultProject) {
          console.log(pc.green(`✓ Found default project (${defaultProject.decision_count} decisions)`));
          projectConfig = {
            project_id: defaultProject.id,
            project_name: defaultProject.name,
          };
        }
      } catch {
        // fall through to select/create
      }
    }

    if (!projectConfig) {
      projectConfig = await selectOrCreateProject(
        existing.supabase_url,
        existing.supabase_service_role_key,
        existing.api_key,
        existing.org_id,
        existing.member_id || null,
      );
    }
  }

  const configPath = await writeProjectConfig(process.cwd(), projectConfig);
  console.log(pc.green(`✓ Project config saved to ${configPath}`));

  // T038: Check for legacy Qdrant points missing project_id
  try {
    const qdrant = getQdrantClient(existing.qdrant_url, existing.qdrant_api_key);
    const legacyCount = await countLegacyPoints(qdrant, existing.org_id);
    if (legacyCount > 0) {
      console.log(pc.yellow(`\n  ${legacyCount} search index entries need project_id backfill.`));
      console.log(pc.dim('  Run `valis admin migrate-qdrant` to update the search index.'));
      console.log(pc.dim('  Search still works during migration (legacy points included in results).'));
    }
  } catch {
    // Qdrant may not be reachable — not fatal for config migration
  }

  // Print summary
  console.log(pc.bold('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
  console.log(pc.bold('  Project Configured!'));
  console.log(pc.bold('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
  console.log(`\n  Org: ${pc.cyan(existing.org_name)}`);
  console.log(`  Project: ${pc.cyan(projectConfig.project_name)}`);
  console.log(`  Author: ${existing.author_name}`);
  console.log(`\n  Next: Start your IDE — Valis MCP server will run automatically.`);
  console.log(`  Or run: ${pc.dim('valis serve')} to test manually.\n`);
  await detectCompetingHooks();
}

// ===========================================================================
// Case E — fresh install (no existing config)
// ===========================================================================
//
// Returns 'needs_retry' when the user chose to log in mid-flow — the
// dispatcher should re-enter `initCommand` so the now-logged-in user hits
// Case A. Returns 'completed' on success or abort.

// 024 — `options` carries `--template` but dispatcher already gated on
// "logged-in required" so fresh-install never sees a non-empty template
// here. Param kept for signature symmetry with the other cases.
export async function runFreshInstall(_options: InitOptions = {}): Promise<FreshInstallOutcome> {
  // Check if user wants to login first
  let creds = await loadCredentials();
  let setupMode: SetupMode = 'hosted';

  if (!creds) {
    const authChoice = await select({
      message: 'How would you like to start?',
      choices: [
        { name: 'Log in (I already have an account)', value: 'login' as const },
        { name: 'Create new account (hosted, free)', value: 'hosted' as const },
        { name: 'Community — Self-hosted, bring your own infra', value: 'community' as const },
      ],
    });

    if (authChoice === 'login') {
      const { runLogin } = await import('../login.js');
      const loginSuccess = await runLogin();
      if (!loginSuccess) return 'completed';
      creds = await loadCredentials();
      // After login, dispatcher re-enters initCommand — now logged in,
      // so the fast path (Case A) handles the rest.
      if (creds) return 'needs_retry';
    }

    setupMode = authChoice === 'community' ? 'community' : 'hosted';
  }

  let config: ValisConfig;
  let projectConfig: ProjectConfig;

  if (setupMode === 'hosted') {
    // -----------------------------------------------------------------
    // Hosted mode: public registration API — no credentials needed
    // -----------------------------------------------------------------
    const authorName = await input({ message: 'Your name:' });
    const email = await input({ message: 'Your email:' });
    const orgName = authorName; // personal org = author name (like GitHub)
    const projectName = await input({ message: 'Project name:', default: basename(process.cwd()) });

    console.log(pc.cyan('\nRegistering with Valis Cloud...'));

    try {
      const regResult = await register(orgName, projectName, authorName, HOSTED_SUPABASE_URL, email);
      console.log(pc.green(`✓ Organization "${regResult.org_name}" created`));
      console.log(pc.green(`✓ Project "${regResult.project_name}" created`));

      config = {
        org_id: regResult.org_id,
        org_name: regResult.org_name,
        api_key: '', // no org api_key on client in hosted mode
        invite_code: regResult.invite_code,
        author_name: authorName,
        supabase_url: regResult.supabase_url,
        supabase_service_role_key: '', // NO service_role_key in hosted mode
        qdrant_url: regResult.qdrant_url,
        qdrant_api_key: regResult.qdrant_api_key || '', // read-only key for hosted search
        configured_ides: [],
        created_at: new Date().toISOString(),
        member_api_key: regResult.member_api_key,
        member_id: regResult.member_id,
        auth_mode: 'jwt' as const, // hosted mode always uses JWT
      };

      projectConfig = {
        project_id: regResult.project_id,
        project_name: regResult.project_name,
      };
    } catch (err) {
      console.log(pc.red(`\n${(err as Error).message}`));
      return 'completed';
    }
  } else {
    // -----------------------------------------------------------------
    // T036: Community mode: user provides own credentials (unchanged)
    // Verified: prompts for 4 credentials (Supabase URL, Service Role Key,
    // Qdrant URL, Qdrant API Key). Config saves supabase_service_role_key.
    // createOrg() falls through to direct SQL for non-EF cases.
    // No hosted-API-URL references in community code paths.
    // -----------------------------------------------------------------
    console.log(pc.cyan('\nCommunity setup — provide your own infrastructure:\n'));
    const supabaseUrl = process.env.SUPABASE_URL || await prompt('Supabase URL: ');
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || await prompt('Supabase Service Role Key: ');
    const qdrantUrl = process.env.QDRANT_URL || await prompt('Qdrant URL: ');
    const qdrantApiKey = process.env.QDRANT_API_KEY || await prompt('Qdrant API Key: ');

    // #299 — Community version-guard. The DB is reachable with the service-role
    // key now; block init if the self-host schema is behind what this CLI needs
    // (warn if it is ahead). Runs before any write.
    await assertSchemaCompatible({
      supabase_url: supabaseUrl,
      supabase_service_role_key: serviceRoleKey,
    } as ValisConfig);

    const orgName = await input({ message: 'Organization name:', default: basename(process.cwd()) });
    const authorName = await input({ message: 'Your name:' });

    console.log(pc.cyan('\nCreating organization...'));
    const result = await createOrg(supabaseUrl, serviceRoleKey, orgName, authorName);
    console.log(pc.green(`✓ Organization "${orgName}" created`));

    config = {
      org_id: result.org_id,
      org_name: orgName,
      api_key: result.api_key,
      invite_code: result.invite_code,
      author_name: authorName,
      supabase_url: supabaseUrl,
      supabase_service_role_key: serviceRoleKey,
      qdrant_url: qdrantUrl,
      qdrant_api_key: qdrantApiKey,
      configured_ides: [],
      created_at: new Date().toISOString(),
      member_id: result.member_id || null,
    };

    // Create first project
    const defaultProjectName = basename(process.cwd());
    projectConfig = await promptAndCreateProject(
      supabaseUrl,
      config.api_key,
      config.org_id,
      defaultProjectName,
      config.supabase_service_role_key,
      null,
      config.member_id,
    );
  }

  // Save global config
  await saveConfig(config);
  await trackFile({ type: 'config_dir', path: getConfigDir() });
  console.log(pc.green('✓ Config saved'));

  // Write .valis.json
  const projectConfigPath = await writeProjectConfig(process.cwd(), projectConfig);
  console.log(pc.green(`✓ Project config saved to ${projectConfigPath}`));

  // Detect and configure IDEs
  const detectedNames = await setupIDEs(config);
  config.configured_ides = detectedNames;
  await saveConfig(config);

  // Ensure Qdrant collection in community/self-host mode (direct Qdrant access).
  // Discriminator is service_role_key (direct mode), NOT qdrant_api_key — a
  // self-hosted local Qdrant has no API key but still needs its collection
  // bootstrapped, else the first store fails with "Not Found" (#299). This must
  // match the seed block below, which also keys off service_role_key and would
  // otherwise deref a null qdrant. Hosted mode uses the API proxy — no direct access.
  let qdrant: ReturnType<typeof getQdrantClient> | null = null;
  if (config.supabase_service_role_key) {
    qdrant = await setupQdrant(config.qdrant_url, config.qdrant_api_key);
  }

  // Seed brain
  if (config.supabase_service_role_key) {
    // Community mode: direct Supabase + Qdrant writes
    await seedAndVerify(config, projectConfig, qdrant!);
  } else {
    // Hosted mode: parse locally, send to server-side seed endpoint via resolveApiPath
    console.log(pc.cyan('\nSeeding team brain (via hosted API)...'));
    try {
      const seedResult = await runHostedSeed(
        process.cwd(),
        config.supabase_url,
        config.member_api_key || config.api_key,
        projectConfig.project_id,
      );
      if (seedResult.stored > 0) {
        console.log(pc.green(`✓ Seeded ${seedResult.stored} decisions from ${Object.keys(seedResult.sources).join(', ') || 'sources'}`));
      } else if (seedResult.total === 0) {
        console.log(pc.dim('  No decisions found to seed (empty CLAUDE.md/AGENTS.md/git history).'));
      } else {
        console.log(pc.yellow(`⚠ Seed: ${seedResult.skipped} decisions skipped (duplicates or errors).`));
      }
    } catch (err) {
      console.log(pc.yellow(`⚠ Seed skipped: ${(err as Error).message}`));
    }
  }

  // Feature 023 US4 — telemetry consent dialog (idempotent: silent if
  // already decided). Self-hosted detection from supabase_url; per FR-022
  // self-hosted defaults to local recording without transmission.
  await runTelemetryConsent(config.supabase_url);

  // Feature 023 US3 — Memory.md migration prompt. Idempotent via
  // SHA-256 source-dedup hash; declined entries are suppressed for 30 days.
  await runMemoryMigration(process.cwd(), projectConfig.project_id);

  // Funnel-event emit: both `install` (fresh install path) and `init_completed`
  // fire here. Server-side bridge in /api/projects/[id]/metrics mirrors these
  // to PostHog (see packages/web/src/lib/adoption-metrics.ts). Consent-gated;
  // best-effort: telemetry MUST NEVER crash init.
  await emitAdoptionEvents(projectConfig.project_id, [
    { event_type: 'install' },
    { event_type: 'init_completed' },
  ]);

  // Print final summary
  await printSummary(config, projectConfig, false);
  return 'completed';
}
