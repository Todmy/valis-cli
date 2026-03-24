import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import pc from 'picocolors';
import { loadConfig, saveConfig, getConfigDir } from '../config/store.js';
import { findProjectConfig, writeProjectConfig } from '../config/project.js';
import { trackFile } from '../config/manifest.js';
import { detectIDEs } from '../ide/detect.js';
import { configureClaudeCodeMCP, injectClaudeMdMarkers } from '../ide/claude-code.js';
import { configureCodexMCP, injectAgentsMdMarkers } from '../ide/codex.js';
import { configureCursorMCP, injectCursorrules } from '../ide/cursor.js';
import { runSeed } from '../seed/index.js';
import {
  getSupabaseClient,
  storeDecision,
  listMemberProjects,
  createProject,
  joinProject,
} from '../cloud/supabase.js';
import type { ProjectInfo } from '../cloud/supabase.js';
import { getQdrantClient, ensureCollection } from '../cloud/qdrant.js';
import { upsertDecision, hybridSearch } from '../cloud/qdrant.js';
import type { TeamindConfig, ProjectConfig } from '../types.js';

// ---------------------------------------------------------------------------
// Hosted Teamind credentials (baked into the CLI for hosted mode)
// These point to the shared Teamind cloud infrastructure.
// Community mode users provide their own.
// ---------------------------------------------------------------------------
// Hosted credentials resolved from environment variables at runtime.
// For production: these will come from a registration API (api.teamind.dev).
// For dog fooding: set TEAMIND_HOSTED_* env vars or use ~/.teamind/.hosted-env
const HOSTED_CREDENTIALS = {
  supabaseUrl: process.env.TEAMIND_HOSTED_SUPABASE_URL || '',
  supabaseServiceRoleKey: process.env.TEAMIND_HOSTED_SUPABASE_KEY || '',
  qdrantUrl: process.env.TEAMIND_HOSTED_QDRANT_URL || '',
  qdrantApiKey: process.env.TEAMIND_HOSTED_QDRANT_KEY || '',
};

function parseEnvContent(content: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx > 0) {
      env[trimmed.slice(0, eqIdx).trim()] = trimmed.slice(eqIdx + 1).trim();
    }
  }
  return env;
}

function loadHostedEnv(): Record<string, string> {
  // Priority: ~/.teamind/.hosted-env → cwd/.env → package/.env
  const homeDir = process.env.HOME || process.env.USERPROFILE || '';
  const candidates = [
    resolve(homeDir, '.teamind', '.hosted-env'),
    resolve(process.cwd(), '.env'),
    resolve(dirname(fileURLToPath(import.meta.url)), '../../.env'),
  ];
  for (const path of candidates) {
    if (existsSync(path)) {
      return parseEnvContent(readFileSync(path, 'utf-8'));
    }
  }
  return {};
}

type SetupMode = 'hosted' | 'community';

async function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const answer = await rl.question(question);
    return answer.trim();
  } finally {
    rl.close();
  }
}

async function createOrg(supabaseUrl: string, serviceRoleKey: string, name: string, authorName: string) {
  const response = await fetch(`${supabaseUrl}/functions/v1/create-org`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, author_name: authorName }),
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(`Failed to create org: ${error.error || 'unknown error'}`);
  }

  return response.json() as Promise<{
    org_id: string;
    api_key: string;
    invite_code: string;
    author_name: string;
    role: string;
    member_id?: string;
  }>;
}

async function joinOrg(supabaseUrl: string, serviceRoleKey: string, inviteCode: string, authorName: string) {
  const response = await fetch(`${supabaseUrl}/functions/v1/join-org`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ invite_code: inviteCode, author_name: authorName }),
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(`Failed to join org: ${error.error || 'unknown error'}`);
  }

  return response.json() as Promise<{
    org_id: string;
    org_name: string;
    api_key: string;
    member_count: number;
    decision_count: number;
    role: string;
    member_id?: string;
  }>;
}

// ---------------------------------------------------------------------------
// Resolve hosted/community credentials
// ---------------------------------------------------------------------------

interface ResolvedCredentials {
  supabaseUrl: string;
  serviceRoleKey: string;
  qdrantUrl: string;
  qdrantApiKey: string;
  setupMode: SetupMode;
}

async function resolveCredentials(isJoin: boolean): Promise<ResolvedCredentials | null> {
  let setupMode: SetupMode;

  if (isJoin) {
    setupMode = 'hosted';
  } else {
    console.log(pc.bold('Choose your setup:\n'));
    console.log(`  ${pc.green('1)')} ${pc.bold('Hosted')} ${pc.dim('(recommended)')} — Free tier included, no setup needed`);
    console.log(`  ${pc.yellow('2)')} ${pc.bold('Community')} — Self-hosted, bring your own Supabase + Qdrant\n`);
    const modeAnswer = await prompt('Your choice (1/2): ');
    setupMode = modeAnswer.trim() === '2' ? 'community' : 'hosted';
  }

  let supabaseUrl: string;
  let serviceRoleKey: string;
  let qdrantUrl: string;
  let qdrantApiKey: string;

  if (setupMode === 'hosted') {
    const envFile = loadHostedEnv();
    supabaseUrl = HOSTED_CREDENTIALS.supabaseUrl || envFile.TEAMIND_HOSTED_SUPABASE_URL || envFile.SUPABASE_URL || '';
    serviceRoleKey = HOSTED_CREDENTIALS.supabaseServiceRoleKey || envFile.TEAMIND_HOSTED_SUPABASE_KEY || envFile.SUPABASE_SERVICE_ROLE_KEY || '';
    qdrantUrl = HOSTED_CREDENTIALS.qdrantUrl || envFile.TEAMIND_HOSTED_QDRANT_URL || envFile.QDRANT_URL || '';
    qdrantApiKey = HOSTED_CREDENTIALS.qdrantApiKey || envFile.TEAMIND_HOSTED_QDRANT_KEY || envFile.QDRANT_API_KEY || '';

    if (!serviceRoleKey) {
      console.log(pc.red('\n✗ Hosted credentials not configured yet.'));
      console.log(pc.dim('  Create ~/.teamind/.hosted-env with:'));
      console.log(pc.dim('    TEAMIND_HOSTED_SUPABASE_URL=https://...'));
      console.log(pc.dim('    TEAMIND_HOSTED_SUPABASE_KEY=sb_secret_...'));
      console.log(pc.dim('    TEAMIND_HOSTED_QDRANT_URL=https://...'));
      console.log(pc.dim('    TEAMIND_HOSTED_QDRANT_KEY=...'));
      console.log(pc.dim('  Or set TEAMIND_HOSTED_* environment variables.\n'));
      return null;
    }

    if (!isJoin) {
      console.log(pc.green('\n✓ Using hosted Teamind infrastructure'));
    }
  } else {
    console.log(pc.cyan('\nCommunity setup — provide your own infrastructure:\n'));
    supabaseUrl = process.env.SUPABASE_URL || await prompt('Supabase URL: ');
    serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || await prompt('Supabase Service Role Key: ');
    qdrantUrl = process.env.QDRANT_URL || await prompt('Qdrant URL: ');
    qdrantApiKey = process.env.QDRANT_API_KEY || await prompt('Qdrant API Key: ');
  }

  return { supabaseUrl, serviceRoleKey, qdrantUrl, qdrantApiKey, setupMode };
}

// ---------------------------------------------------------------------------
// Project selection / creation helpers
// ---------------------------------------------------------------------------

/**
 * Prompt for project name and create the project via Edge Function.
 * Returns the ProjectConfig to write to .teamind.json.
 */
async function promptAndCreateProject(
  supabaseUrl: string,
  apiKey: string,
  orgId: string,
  defaultName?: string,
): Promise<ProjectConfig> {
  const projectName = await prompt(
    `Project name${defaultName ? ` (${defaultName})` : ''}: `,
  ) || defaultName || basename(process.cwd());

  console.log(pc.cyan(`\nCreating project "${projectName}"...`));
  const result = await createProject(supabaseUrl, apiKey, orgId, projectName);
  console.log(pc.green(`✓ Project "${projectName}" created`));

  return {
    project_id: result.project_id,
    project_name: result.project_name,
  };
}

/**
 * List member's projects and let them select an existing one or create new.
 * Returns the ProjectConfig to write to .teamind.json.
 */
async function selectOrCreateProject(
  supabaseUrl: string,
  serviceRoleKey: string,
  apiKey: string,
  orgId: string,
  memberId: string | null,
): Promise<ProjectConfig> {
  let projects: ProjectInfo[] = [];

  if (memberId) {
    try {
      const supabase = getSupabaseClient(supabaseUrl, serviceRoleKey);
      projects = await listMemberProjects(supabase, memberId);
    } catch {
      // list_member_projects not yet available — fall through to create new
    }
  }

  if (projects.length > 0) {
    console.log(pc.bold('\nYour projects:\n'));
    for (let i = 0; i < projects.length; i++) {
      const p = projects[i];
      console.log(
        `  ${pc.green(`${i + 1})`)} ${pc.bold(p.name)} ${pc.dim(`(${p.decision_count} decisions)`)}`,
      );
    }
    console.log(`  ${pc.yellow(`${projects.length + 1})`)} Create new project\n`);

    const choice = await prompt(`Select (1-${projects.length + 1}): `);
    const idx = parseInt(choice, 10) - 1;

    if (idx >= 0 && idx < projects.length) {
      const selected = projects[idx];
      console.log(pc.green(`✓ Selected project "${selected.name}"`));
      return {
        project_id: selected.id,
        project_name: selected.name,
      };
    }
  }

  // Create new project
  const defaultName = basename(process.cwd());
  return promptAndCreateProject(supabaseUrl, apiKey, orgId, defaultName);
}

// ---------------------------------------------------------------------------
// IDE + Qdrant + Seed helpers (extracted from old monolithic flow)
// ---------------------------------------------------------------------------

async function setupIDEs(config: TeamindConfig): Promise<string[]> {
  console.log(pc.cyan('\nDetecting IDEs...'));
  const ides = await detectIDEs();
  const detectedNames: string[] = [];

  for (const ide of ides) {
    if (!ide.detected) continue;
    detectedNames.push(ide.name);

    if (ide.name === 'claude-code') {
      await configureClaudeCodeMCP(process.cwd());
      await injectClaudeMdMarkers(process.cwd());
      console.log(pc.green('  ✓ Claude Code: MCP configured, CLAUDE.md updated'));
    } else if (ide.name === 'codex') {
      await configureCodexMCP();
      await injectAgentsMdMarkers(process.cwd());
      console.log(pc.green('  ✓ Codex: MCP configured, AGENTS.md updated'));
    } else if (ide.name === 'cursor') {
      await configureCursorMCP();
      await injectCursorrules(process.cwd());
      console.log(pc.green('  ✓ Cursor: MCP configured, .cursorrules updated'));
    }
  }

  if (detectedNames.length === 0) {
    console.log(pc.yellow('  No supported IDEs detected. Configure manually later.'));
  }

  return detectedNames;
}

async function setupQdrant(qdrantUrl: string, qdrantApiKey: string) {
  console.log(pc.cyan('\nInitializing search index...'));
  const qdrant = getQdrantClient(qdrantUrl, qdrantApiKey);
  try {
    await ensureCollection(qdrant);
    console.log(pc.green('✓ Qdrant collection ready'));
  } catch (err) {
    console.log(pc.yellow(`⚠ Qdrant setup skipped: ${(err as Error).message}`));
  }
  return qdrant;
}

async function seedAndVerify(
  config: TeamindConfig,
  projectConfig: ProjectConfig,
  qdrant: ReturnType<typeof getQdrantClient>,
) {
  console.log(pc.cyan('\nSeeding team brain...'));
  const supabase = getSupabaseClient(config.supabase_url, config.supabase_service_role_key);

  try {
    const seedResult = await runSeed(
      process.cwd(),
      config.org_id,
      config.author_name,
      supabase,
      qdrant,
      projectConfig.project_id,
    );
    console.log(pc.green(`✓ Seeded ${seedResult.stored} decisions from ${Object.keys(seedResult.sources).join(', ') || 'sources'}`));
  } catch (err) {
    console.log(pc.yellow(`⚠ Seed skipped: ${(err as Error).message}`));
  }

  // Verification round-trip
  console.log(pc.cyan('\nVerifying round-trip...'));
  try {
    const testDecision = await storeDecision(
      supabase,
      config.org_id,
      {
        text: 'Teamind initialized successfully — this is a verification decision',
        project_id: projectConfig.project_id,
      },
      config.author_name,
      'seed',
    );
    await upsertDecision(qdrant, config.org_id, testDecision.id, {
      text: 'Teamind initialized successfully — this is a verification decision',
      project_id: projectConfig.project_id,
    }, config.author_name);

    const searchResults = await hybridSearch(qdrant, config.org_id, 'verification');
    if (searchResults.length > 0) {
      console.log(pc.green('✓ Store + search round-trip verified'));
    } else {
      console.log(pc.yellow('⚠ Search returned no results (may take a moment to index)'));
    }
  } catch (err) {
    console.log(pc.yellow(`⚠ Round-trip verification skipped: ${(err as Error).message}`));
  }
}

function printSummary(config: TeamindConfig, projectConfig: ProjectConfig, isJoin: boolean) {
  console.log(pc.bold('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
  console.log(pc.bold('  Setup Complete!'));
  console.log(pc.bold('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
  console.log(`\n  Org: ${pc.cyan(config.org_name)}`);
  console.log(`  Project: ${pc.cyan(projectConfig.project_name)}`);
  console.log(`  Author: ${config.author_name}`);
  if (!isJoin) {
    console.log(`\n  ${pc.bold('Invite code:')} ${pc.green(config.invite_code)}`);
    console.log(`  Share with teammates: ${pc.dim('teamind init --join ' + config.invite_code)}`);
  }
  console.log(`\n  Next: Start your IDE — Teamind MCP server will run automatically.`);
  console.log(`  Or run: ${pc.dim('teamind serve')} to test manually.\n`);
}

// ---------------------------------------------------------------------------
// Main init command
// ---------------------------------------------------------------------------

export async function initCommand(options: { join?: string }): Promise<void> {
  console.log(pc.bold('\n🧠 Teamind Setup\n'));

  const existing = await loadConfig();
  const existingProject = await findProjectConfig(process.cwd());

  // -----------------------------------------------------------------------
  // Case 3: --join <invite-code> — join a project via invite code
  // -----------------------------------------------------------------------
  if (options.join) {
    const creds = await resolveCredentials(true);
    if (!creds) return;

    console.log(pc.cyan(`\nJoining project with invite code: ${options.join}`));
    const authorName = await prompt('Your name: ');

    // Try join-project first (project-level invite code)
    let joinedViaProject = false;
    let projectConfig: ProjectConfig | undefined;
    let config: TeamindConfig;

    try {
      const result = await joinProject(creds.supabaseUrl, options.join, authorName);
      joinedViaProject = true;
      console.log(pc.green(`✓ Joined project "${result.project_name}" in org "${result.org_name}"`));

      projectConfig = {
        project_id: result.project_id,
        project_name: result.project_name,
      };

      // Save or keep global config
      if (!existing || existing.org_id !== result.org_id) {
        config = {
          org_id: result.org_id,
          org_name: result.org_name,
          api_key: result.api_key,
          invite_code: options.join,
          author_name: authorName,
          supabase_url: creds.supabaseUrl,
          supabase_service_role_key: creds.serviceRoleKey,
          qdrant_url: creds.qdrantUrl,
          qdrant_api_key: creds.qdrantApiKey,
          configured_ides: existing?.configured_ides || [],
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
    } catch {
      // Fall back to join-org (legacy org-level invite code)
      const result = await joinOrg(creds.supabaseUrl, creds.serviceRoleKey, options.join, authorName);
      console.log(pc.green(`✓ Joined org "${result.org_name}" (${result.member_count} members)`));
      console.log(`  ${result.decision_count} decisions already available`);

      config = {
        org_id: result.org_id,
        org_name: result.org_name,
        api_key: result.api_key,
        invite_code: options.join,
        author_name: authorName,
        supabase_url: creds.supabaseUrl,
        supabase_service_role_key: creds.serviceRoleKey,
        qdrant_url: creds.qdrantUrl,
        qdrant_api_key: creds.qdrantApiKey,
        configured_ides: [],
        created_at: new Date().toISOString(),
        member_id: result.member_id || null,
      };

      await saveConfig(config);
      await trackFile({ type: 'config_dir', path: getConfigDir() });
      console.log(pc.green('✓ Global config saved'));

      // After joining org, select/create project
      projectConfig = await selectOrCreateProject(
        creds.supabaseUrl,
        creds.serviceRoleKey,
        config.api_key,
        config.org_id,
        config.member_id || null,
      );
    }

    // Write .teamind.json
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
      printSummary(config, projectConfig, true);
    }
    return;
  }

  // -----------------------------------------------------------------------
  // Case 4: Reconfigure — both global config and .teamind.json exist
  // -----------------------------------------------------------------------
  if (existing && existingProject) {
    console.log(pc.yellow('Teamind is already configured for this directory.'));
    console.log(`  Org: ${existing.org_name}`);
    console.log(`  Project: ${existingProject.project_name}`);
    console.log(`  Author: ${existing.author_name}`);
    console.log('');
    console.log(`  ${pc.green('1)')} Switch project`);
    console.log(`  ${pc.yellow('2)')} Reconfigure org (full reset)`);
    console.log(`  ${pc.dim('3)')} Cancel\n`);

    const answer = await prompt('Your choice (1/2/3): ');

    if (answer === '1') {
      // Switch project only — global config unchanged
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
      return;
    } else if (answer !== '2') {
      console.log('Aborted.');
      return;
    }
    // answer === '2' falls through to full setup below
  }

  // -----------------------------------------------------------------------
  // Case 2: Org exists, no .teamind.json — legacy config migration path
  //
  // T038 (US6): When an upgraded CLI detects global config but no
  // .teamind.json, this is a legacy installation that was configured
  // before multi-project support. We try to find the default project
  // and write .teamind.json automatically, or fall through to the
  // standard project selection flow.
  // -----------------------------------------------------------------------
  if (existing && !existingProject) {
    console.log(pc.yellow('Legacy config detected: org configured but no project selected.'));
    console.log(pc.green(`  Org: ${existing.org_name}`));
    console.log(pc.dim('  Upgrading to multi-project mode...\n'));

    let projectConfig: ProjectConfig | undefined;

    // Try to find the default project created by migration 004
    if (existing.member_id) {
      try {
        const supabase = getSupabaseClient(
          existing.supabase_url,
          existing.supabase_service_role_key,
        );
        const projects = await listMemberProjects(supabase, existing.member_id);
        const defaultProject = projects.find((p) => p.name === 'default');

        if (defaultProject) {
          console.log(pc.green(`✓ Found default project from migration (${defaultProject.decision_count} decisions)`));
          projectConfig = {
            project_id: defaultProject.id,
            project_name: defaultProject.name,
          };
        }
      } catch {
        // list_member_projects not available — fall through to select/create
      }
    }

    // If no default project found, let user select or create one
    if (!projectConfig) {
      projectConfig = await selectOrCreateProject(
        existing.supabase_url,
        existing.supabase_service_role_key,
        existing.api_key,
        existing.org_id,
        existing.member_id || null,
      );
    }

    const configPath = await writeProjectConfig(process.cwd(), projectConfig);
    console.log(pc.green(`✓ Project config saved to ${configPath}`));

    // Print summary
    console.log(pc.bold('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
    console.log(pc.bold('  Project Configured!'));
    console.log(pc.bold('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
    console.log(`\n  Org: ${pc.cyan(existing.org_name)}`);
    console.log(`  Project: ${pc.cyan(projectConfig.project_name)}`);
    console.log(`  Author: ${existing.author_name}`);
    console.log(`\n  Next: Start your IDE — Teamind MCP server will run automatically.`);
    console.log(`  Or run: ${pc.dim('teamind serve')} to test manually.\n`);
    return;
  }

  // -----------------------------------------------------------------------
  // Case 1: Fresh install — full org + project creation
  // -----------------------------------------------------------------------
  const creds = await resolveCredentials(false);
  if (!creds) return;

  let config: TeamindConfig;

  // Create new org
  const orgName = await prompt('Organization name: ');
  const authorName = await prompt('Your name: ');

  console.log(pc.cyan('\nCreating organization...'));
  const result = await createOrg(creds.supabaseUrl, creds.serviceRoleKey, orgName, authorName);
  console.log(pc.green(`✓ Organization "${orgName}" created`));

  config = {
    org_id: result.org_id,
    org_name: orgName,
    api_key: result.api_key,
    invite_code: result.invite_code,
    author_name: authorName,
    supabase_url: creds.supabaseUrl,
    supabase_service_role_key: creds.serviceRoleKey,
    qdrant_url: creds.qdrantUrl,
    qdrant_api_key: creds.qdrantApiKey,
    configured_ides: [],
    created_at: new Date().toISOString(),
    member_id: result.member_id || null,
  };

  // Save global config
  await saveConfig(config);
  await trackFile({ type: 'config_dir', path: getConfigDir() });
  console.log(pc.green('✓ Config saved'));

  // Create first project
  const defaultProjectName = basename(process.cwd());
  const projectConfig = await promptAndCreateProject(
    creds.supabaseUrl,
    config.api_key,
    config.org_id,
    defaultProjectName,
  );

  // Write .teamind.json
  const projectConfigPath = await writeProjectConfig(process.cwd(), projectConfig);
  console.log(pc.green(`✓ Project config saved to ${projectConfigPath}`));

  // Detect and configure IDEs
  const detectedNames = await setupIDEs(config);
  config.configured_ides = detectedNames;
  await saveConfig(config);

  // Ensure Qdrant collection
  const qdrant = await setupQdrant(creds.qdrantUrl, creds.qdrantApiKey);

  // Seed brain
  await seedAndVerify(config, projectConfig, qdrant);

  // Print final summary
  printSummary(config, projectConfig, false);
}
