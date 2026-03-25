import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { basename } from 'node:path';
import pc from 'picocolors';
import { loadConfig, saveConfig, getConfigDir } from '../config/store.js';
import { findProjectConfig, writeProjectConfig } from '../config/project.js';
import { trackFile } from '../config/manifest.js';
import { detectIDEs } from '../ide/detect.js';
import { configureClaudeCodeMCP, injectClaudeMdMarkers } from '../ide/claude-code.js';
import { configureCodexMCP, injectAgentsMdMarkers } from '../ide/codex.js';
import { configureCursorMCP, injectCursorrules } from '../ide/cursor.js';
import { runSeed, runHostedSeed } from '../seed/index.js';
import {
  getSupabaseClient,
  storeDecision,
  listMemberProjects,
  createProject,
  joinProject,
} from '../cloud/supabase.js';
import type { ProjectInfo } from '../cloud/supabase.js';
import { getQdrantClient, ensureCollection, countLegacyPoints } from '../cloud/qdrant.js';
import { upsertDecision, hybridSearch } from '../cloud/qdrant.js';
import type { TeamindConfig, ProjectConfig } from '../types.js';
import { HOSTED_SUPABASE_URL } from '../types.js';
import { register, joinPublic } from '../cloud/registration.js';

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
  // Try Edge Function first (works with Supabase Cloud)
  // Fall back to direct SQL (works with local Postgres / community mode)
  try {
    const response = await fetch(`${supabaseUrl}/functions/v1/create-org`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, author_name: authorName }),
    });

    if (response.ok) {
      return response.json() as Promise<{
        org_id: string;
        api_key: string;
        invite_code: string;
        author_name: string;
        role: string;
        member_id?: string;
        member_api_key?: string;
      }>;
    }

    const error = await response.json().catch(() => ({ error: 'unknown' }));
    // If Edge Function not found (404) or unavailable, fall through to direct SQL
    if (response.status !== 404 && response.status !== 502 && response.status !== 503) {
      throw new Error(`Failed to create org: ${error.error || 'unknown error'}`);
    }
  } catch (err) {
    if ((err as Error).message.startsWith('Failed to create org:')) throw err;
    // Network error or EF not available — fall through to direct SQL
  }

  // Direct SQL fallback (community / self-hosted mode)
  const supabase = getSupabaseClient(supabaseUrl, serviceRoleKey);
  const orgId = crypto.randomUUID();
  const hex = (n: number) => [...Array(n)].map(() => Math.floor(Math.random() * 16).toString(16)).join('');
  const apiKey = `tm_${hex(32)}`;
  const memberKey = `tmm_${hex(32)}`;
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const inviteCode = [...Array(4)].map(() => chars[Math.floor(Math.random() * chars.length)]).join('')
    + '-' + [...Array(4)].map(() => chars[Math.floor(Math.random() * chars.length)]).join('');

  const { error: orgErr } = await supabase.from('orgs').insert({
    id: orgId, name, api_key: apiKey, invite_code: inviteCode, plan: 'free',
  });
  if (orgErr) throw new Error(`Failed to create org: ${orgErr.message}`);

  const memberId = crypto.randomUUID();
  const { error: memErr } = await supabase.from('members').insert({
    id: memberId, org_id: orgId, author_name: authorName, role: 'admin', api_key: memberKey,
  });
  if (memErr) {
    await supabase.from('orgs').delete().eq('id', orgId);
    throw new Error(`Failed to create member: ${memErr.message}`);
  }

  return {
    org_id: orgId, api_key: apiKey, invite_code: inviteCode,
    author_name: authorName, role: 'admin',
    member_id: memberId, member_api_key: memberKey,
  };
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
  serviceRoleKey?: string,
): Promise<ProjectConfig> {
  const projectName = await prompt(
    `Project name${defaultName ? ` (${defaultName})` : ''}: `,
  ) || defaultName || basename(process.cwd());

  console.log(pc.cyan(`\nCreating project "${projectName}"...`));
  const result = await createProject(supabaseUrl, apiKey, orgId, projectName, serviceRoleKey);
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
  //
  // Hosted mode (no existing config or no service_role_key): call
  // joinPublic() — a public endpoint that requires no pre-existing
  // credentials. The response includes supabase_url, qdrant_url, and
  // member_api_key — everything the CLI needs to configure from scratch.
  //
  // Community / existing config with service_role_key: use joinProject()
  // with the already-known supabase_url.
  // -----------------------------------------------------------------------
  if (options.join) {
    console.log(pc.cyan(`\nJoining project with invite code: ${options.join}`));
    const authorName = await prompt('Your name: ');

    let projectConfig: ProjectConfig | undefined;
    let config: TeamindConfig;

    // Hosted: no existing config, or existing config has no service_role_key.
    const useHostedJoin = !existing || !existing.supabase_service_role_key;

    if (useHostedJoin) {
      // ------------------------------------------------------------------
      // Hosted join: call the public joinPublic() endpoint.
      // No credentials needed — the response provides everything.
      // ------------------------------------------------------------------
      const supabaseUrl = existing?.supabase_url || HOSTED_SUPABASE_URL;

      try {
        const result = await joinPublic(options.join, authorName, supabaseUrl);
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
          invite_code: options.join,
          author_name: authorName,
          supabase_url: result.supabase_url,
          supabase_service_role_key: '', // not needed for hosted mode
          qdrant_url: result.qdrant_url,
          qdrant_api_key: '', // not needed for hosted mode
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
        const result = await joinProject(existing.supabase_url, options.join, authorName);
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
            invite_code: options.join,
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

    // T038: Check for legacy Qdrant points missing project_id
    try {
      const qdrant = getQdrantClient(existing.qdrant_url, existing.qdrant_api_key);
      const legacyCount = await countLegacyPoints(qdrant, existing.org_id);
      if (legacyCount > 0) {
        console.log(pc.yellow(`\n  ${legacyCount} search index entries need project_id backfill.`));
        console.log(pc.dim('  Run `teamind admin migrate-qdrant` to update the search index.'));
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
    console.log(`\n  Next: Start your IDE — Teamind MCP server will run automatically.`);
    console.log(`  Or run: ${pc.dim('teamind serve')} to test manually.\n`);
    return;
  }

  // -----------------------------------------------------------------------
  // Case 1: Fresh install — full org + project creation
  // -----------------------------------------------------------------------

  // Choose setup mode
  console.log(pc.bold('Choose your setup:\n'));
  console.log(`  ${pc.green('1)')} ${pc.bold('Hosted')} ${pc.dim('(recommended)')} — Free tier included, no setup needed`);
  console.log(`  ${pc.yellow('2)')} ${pc.bold('Community')} — Self-hosted, bring your own Supabase + Qdrant\n`);
  const modeAnswer = await prompt('Your choice (1/2): ');
  const setupMode: SetupMode = modeAnswer.trim() === '2' ? 'community' : 'hosted';

  let config: TeamindConfig;
  let projectConfig: ProjectConfig;

  if (setupMode === 'hosted') {
    // -----------------------------------------------------------------
    // Hosted mode: public registration API — no credentials needed
    // -----------------------------------------------------------------
    const orgName = await prompt('Organization name: ');
    const projectName = await prompt(`Project name (${basename(process.cwd())}): `) || basename(process.cwd());
    const authorName = await prompt('Your name: ');

    console.log(pc.cyan('\nRegistering with Teamind Cloud...'));

    try {
      const regResult = await register(orgName, projectName, authorName, HOSTED_SUPABASE_URL);
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
        qdrant_api_key: '', // NO qdrant_api_key in hosted mode
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
      return;
    }
  } else {
    // -----------------------------------------------------------------
    // Community mode: user provides own credentials (unchanged)
    // -----------------------------------------------------------------
    console.log(pc.cyan('\nCommunity setup — provide your own infrastructure:\n'));
    const supabaseUrl = process.env.SUPABASE_URL || await prompt('Supabase URL: ');
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || await prompt('Supabase Service Role Key: ');
    const qdrantUrl = process.env.QDRANT_URL || await prompt('Qdrant URL: ');
    const qdrantApiKey = process.env.QDRANT_API_KEY || await prompt('Qdrant API Key: ');

    const orgName = await prompt('Organization name: ');
    const authorName = await prompt('Your name: ');

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
    );
  }

  // Save global config
  await saveConfig(config);
  await trackFile({ type: 'config_dir', path: getConfigDir() });
  console.log(pc.green('✓ Config saved'));

  // Write .teamind.json
  const projectConfigPath = await writeProjectConfig(process.cwd(), projectConfig);
  console.log(pc.green(`✓ Project config saved to ${projectConfigPath}`));

  // Detect and configure IDEs
  const detectedNames = await setupIDEs(config);
  config.configured_ides = detectedNames;
  await saveConfig(config);

  // Ensure Qdrant collection (community mode has qdrant_api_key; hosted skips gracefully)
  // TODO: implement server-side Qdrant verification for hosted mode
  // In hosted mode, qdrant_api_key is empty so ensureCollection will fail silently.
  // A future `/functions/v1/verify-qdrant` endpoint should verify the collection
  // exists and is healthy using server-side credentials.
  const qdrant = await setupQdrant(config.qdrant_url, config.qdrant_api_key);

  // Seed brain
  if (config.supabase_service_role_key) {
    // Community mode: direct Supabase + Qdrant writes
    await seedAndVerify(config, projectConfig, qdrant);
  } else {
    // Hosted mode: parse locally, send to server-side /functions/v1/seed
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

  // Print final summary
  printSummary(config, projectConfig, false);
}
