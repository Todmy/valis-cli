/**
 * Helpers shared by the init command's case handlers.
 *
 * Each function here is a self-contained step: prompts, third-party calls,
 * file writes. Cases compose them into setup flows. The case handlers
 * (`./cases.ts`) read this module's exports; the public entry point
 * (`../init.ts`) does not — it only dispatches between cases.
 *
 * Internal helpers (e.g. `ynPrompt`) stay un-exported.
 */

import { basename, join } from 'node:path';
import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import select from '@inquirer/select';
import input from '@inquirer/input';
import pc from 'picocolors';
import { installClaudeHooks, injectClaudeMdMarkers, scaffoldBuiltInCommands } from '../../ide/claude-code.js';
import { injectAgentsMdMarkers } from '../../ide/codex.js';
import { injectCursorrules } from '../../ide/cursor.js';
import { ALL_ADAPTERS } from '../../adapters/index.js';
import { writeMcpServer } from '../../adapters/deploy.js';
import { GLOBAL_SCOPE } from '../../adapters/types.js';
import type { McpServerEntry } from '../../adapters/types.js';
import type { HarnessName } from '../../adapters/hook-events.js';
import { trackFile } from '../../config/manifest.js';
import { getTemplate, isTemplateId } from '../../templates/index.js';
import { chooseTemplate, type OrgPlan } from './template-choice.js';
import type { InitOptions } from '../init.js';
import { runSeed } from '../../seed/index.js';
import {
  getSupabaseClient,
  storeDecision,
  listMemberProjects,
  createProject,
} from '../../cloud/supabase.js';
import type { ProjectInfo } from '../../cloud/supabase.js';
import { getQdrantClient, ensureCollection, upsertDecision, hybridSearch } from '../../cloud/qdrant.js';
import type { ValisConfig, ProjectConfig } from '../../types.js';
import { HOSTED_SUPABASE_URL, HOSTED_API_URL } from '../../types.js';
import { resolveApiUrl, resolveApiPath } from '../../cloud/api-url.js';
import { register } from '../../cloud/registration.js';
import type { ValisCredentials } from '../../config/credentials.js';

export async function prompt(question: string): Promise<string> {
  return input({ message: question });
}

export async function createOrg(
  supabaseUrl: string,
  serviceRoleKey: string,
  name: string,
  authorName: string,
) {
  // Try Edge Function / API route first (works with Supabase Cloud / Vercel)
  // Fall back to direct SQL (works with local Postgres / community mode)
  const isHosted = supabaseUrl.replace(/\/$/, '') === HOSTED_SUPABASE_URL;
  const apiBase = resolveApiUrl(supabaseUrl, isHosted);
  const createOrgUrl = resolveApiPath(apiBase, 'create-org');
  try {
    const response = await fetch(createOrgUrl, {
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
 * Returns the ProjectConfig to write to .valis.json.
 *
 * When `templateId` is non-null, the server seeds the chosen constitution
 * template atomically (019/US6). The success path prints an extra
 * "Seeded N decisions from <template name>" confirmation line.
 */
export async function promptAndCreateProject(
  supabaseUrl: string,
  apiKey: string,
  orgId: string,
  defaultName?: string,
  serviceRoleKey?: string,
  templateId?: string | null,
  memberId?: string | null,
): Promise<ProjectConfig> {
  const projectName = await prompt(
    `Project name${defaultName ? ` (${defaultName})` : ''}: `,
  ) || defaultName || basename(process.cwd());

  console.log(pc.cyan(`\nCreating project "${projectName}"...`));
  const result = await createProject(supabaseUrl, apiKey, orgId, projectName, serviceRoleKey, templateId, memberId);
  console.log(pc.green(`✓ Project "${projectName}" created`));

  // 019/US6 + 024: seed confirmation when the server reports a non-zero count.
  if (result.decisions_seeded && result.decisions_seeded > 0) {
    const templateDisplay = templateId && isTemplateId(templateId)
      ? getTemplate(templateId).name
      : result.template_source ?? 'template';
    const source = result.template_source ? ` (${result.template_source})` : '';
    console.log(pc.green(`✓ Seeded ${result.decisions_seeded} decisions from ${templateDisplay}${source}`));
  }

  return {
    project_id: result.project_id,
    project_name: result.project_name,
  };
}

/**
 * List member's projects and let them select an existing one or create new.
 * Returns the ProjectConfig to write to .valis.json.
 */
export async function selectOrCreateProject(
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
    const choices = [
      ...projects.map((p) => ({
        name: `${p.name} (${p.decision_count} decisions)`,
        value: p.id,
      })),
      { name: 'Create new project', value: '__new__' },
    ];

    const selectedId = await select({
      message: 'Select a project:',
      choices,
    });

    if (selectedId !== '__new__') {
      const selected = projects.find((p) => p.id === selectedId)!;
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

export async function setupIDEs(_config: ValisConfig): Promise<string[]> {
  console.log(pc.cyan('\nConfiguring IDEs...'));
  const detectedNames: string[] = [];

  const valisServer: McpServerEntry = {
    name: 'valis',
    command: 'valis',
    args: ['serve'],
    env: {},
    enabled: true,
  };

  for (const adapter of ALL_ADAPTERS) {
    if (!(await adapter.detect())) continue;
    detectedNames.push(adapter.name);

    try {
      // Generic MCP install — one code path covers all 8 harnesses.
      // writeMcpServer handles format dispatch (JSON/TOML/Opencode), atomic
      // write, sanitization, and PATH injection for GUI-launched agents.
      await writeMcpServer(adapter, GLOBAL_SCOPE, valisServer);
      await trackFile({
        type: 'mcp_config',
        path: adapter.mcpConfigPath(),
        ide: adapter.name,
      });

      // Per-harness extras: rule-file injection, hooks, slash commands.
      // Claude/Codex/Cursor have established markdown surfaces Valis claims;
      // the other 5 are MCP-only installs.
      const extras = await applyHarnessExtras(adapter.name, process.cwd());
      console.log(pc.green(`  ✓ ${describeHarness(adapter.name)}: MCP${extras}`));
    } catch (err) {
      console.log(pc.yellow(`  ⚠ ${adapter.name}: ${(err as Error).message}`));
    }
  }

  if (detectedNames.length === 0) {
    console.log(pc.yellow('  No supported IDEs detected. Configure manually later.'));
  }

  return detectedNames;
}

async function applyHarnessExtras(name: HarnessName, projectDir: string): Promise<string> {
  switch (name) {
    case 'claude-code': {
      await installClaudeHooks();
      await injectClaudeMdMarkers(projectDir);
      const cmds = await scaffoldBuiltInCommands(projectDir);
      const cmdMsg = cmds.length > 0 ? ` + /${cmds.join(', /')} commands` : '';
      return ` + hooks + CLAUDE.md${cmdMsg}`;
    }
    case 'codex':
      await injectAgentsMdMarkers(projectDir);
      return ' + AGENTS.md';
    case 'cursor':
      await injectCursorrules(projectDir);
      return ' + .cursorrules';
    case 'gemini':
    case 'copilot':
    case 'windsurf':
    case 'opencode':
    case 'antigravity':
      return '';
  }
}

function describeHarness(name: HarnessName): string {
  switch (name) {
    case 'claude-code': return 'Claude Code';
    case 'codex': return 'Codex';
    case 'cursor': return 'Cursor';
    case 'gemini': return 'Gemini';
    case 'copilot': return 'Copilot';
    case 'windsurf': return 'Windsurf';
    case 'opencode': return 'OpenCode';
    case 'antigravity': return 'Antigravity';
  }
}

export async function setupQdrant(qdrantUrl: string, qdrantApiKey: string) {
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

export async function seedAndVerify(
  config: ValisConfig,
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
        text: 'Valis initialized successfully — this is a verification decision',
        project_id: projectConfig.project_id,
      },
      config.author_name,
      'seed',
    );
    await upsertDecision(qdrant, config.org_id, testDecision.id, {
      text: 'Valis initialized successfully — this is a verification decision',
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

// ---------------------------------------------------------------------------
// Logged-in project selection (uses credentials, no service_role_key)
// ---------------------------------------------------------------------------

/**
 * List accessible projects via the API and let the user pick one.
 * Falls through to project creation via the idempotent register endpoint
 * (blank) or via `createProject` (when a constitution template is selected).
 *
 * `options.template` flows through to the template-choice resolver inside
 * the "Create new project" branch. When the resolver returns a non-null
 * `TemplateId`, we route through `createProject` (which supports
 * `template_id` server-side per 019/US6). When null, we use the legacy
 * `register` endpoint to preserve existing invite-code semantics.
 */
export async function selectOrCreateProjectLoggedIn(
  creds: ValisCredentials,
  options: InitOptions = {},
): Promise<ProjectConfig> {
  // List existing projects via API route (works in hosted mode)
  let projects: Array<{ id: string; name: string; role: string; decision_count: number }> = [];
  try {
    const listRes = await fetch(`${HOSTED_API_URL}/api/list-projects`, {
      headers: { Authorization: `Bearer ${creds.member_api_key}` },
    });
    if (listRes.ok) {
      const body = (await listRes.json()) as {
        projects: Array<{ id: string; name: string; role: string; decision_count: number }>;
      };
      projects = body.projects;
    }
  } catch {
    // Failed to list — fall through to create
  }

  if (projects.length > 0) {
    const choices = [
      ...projects.map((p) => ({
        name: `${p.name} (${p.role}, ${p.decision_count} decisions)`,
        value: p.id,
      })),
      { name: 'Create new project', value: '__new__' },
    ];

    const selectedId = await select({
      message: 'Select a project:',
      choices,
    });

    if (selectedId !== '__new__') {
      const selected = projects.find((p) => p.id === selectedId)!;
      console.log(pc.green(`✓ Selected project "${selected.name}"`));
      return {
        project_id: selected.id,
        project_name: selected.name,
      };
    }
  }

  // Create new project — branch on constitution template choice.
  const defaultName = basename(process.cwd());
  const projectName = await input({
    message: 'Project name:',
    default: defaultName,
  });

  // 024 — Resolve template choice (flag value, interactive picker, or null).
  // Creds don't carry plan; the org plan is unknown at this point. Default
  // 'free' per spec — picker will disable plan-gated rows, server-side
  // `plan_too_low` 402 is the fail-safe if the flag bypasses the picker.
  const templateChoice = await chooseTemplate({
    flagValue: options.template,
    orgPlan: 'free' as OrgPlan,
    nonInteractive: !process.stdin.isTTY,
    newProjectFlow: true,
  });

  console.log(pc.cyan(`\nCreating project "${projectName}"...`));

  if (templateChoice !== null) {
    // Template path — createProject supports `template_id` and atomic seeding.
    const result = await createProject(
      creds.supabase_url || HOSTED_SUPABASE_URL,
      creds.member_api_key,
      creds.org_id,
      projectName,
      undefined,
      templateChoice,
    );
    console.log(pc.green(`✓ Project "${result.project_name}" created`));
    if (result.decisions_seeded && result.decisions_seeded > 0) {
      const tplName = isTemplateId(templateChoice) ? getTemplate(templateChoice).name : templateChoice;
      const sourceTag = result.template_source ? ` (${result.template_source})` : '';
      console.log(pc.green(`✓ Seeded ${result.decisions_seeded} decisions from ${tplName}${sourceTag}`));
    }
    return {
      project_id: result.project_id,
      project_name: result.project_name,
    };
  }

  // Blank path — preserve legacy register-endpoint flow (carries invite_code).
  const regResult = await register(
    creds.org_name,
    projectName,
    creds.author_name,
    creds.supabase_url || HOSTED_SUPABASE_URL,
  );

  console.log(pc.green(`✓ Project "${regResult.project_name}" created`));
  const result: ProjectConfig & { invite_code?: string } = {
    project_id: regResult.project_id,
    project_name: regResult.project_name,
  };
  result.invite_code = regResult.invite_code;
  return result as ProjectConfig;
}

export async function detectCompetingHooks(): Promise<void> {
  const competitors = ['qdrant-find', 'mem0'];
  const warnings: string[] = [];

  // Scan ~/.claude/scripts/
  try {
    const scriptsDir = join(homedir(), '.claude', 'scripts');
    const files = await readdir(scriptsDir);
    for (const file of files) {
      try {
        const content = await readFile(join(scriptsDir, file), 'utf-8');
        for (const comp of competitors) {
          if (content.includes(comp)) {
            warnings.push(`${scriptsDir}/${file} (contains ${comp})`);
          }
        }
      } catch { /* skip unreadable files */ }
    }
  } catch { /* scripts dir doesn't exist */ }

  // Scan ~/.claude/settings.json
  try {
    const settingsPath = join(homedir(), '.claude', 'settings.json');
    const content = await readFile(settingsPath, 'utf-8');
    for (const comp of competitors) {
      if (content.includes(comp)) {
        warnings.push(`${settingsPath} (references ${comp})`);
      }
    }
  } catch { /* settings doesn't exist */ }

  if (warnings.length > 0) {
    console.log();
    console.log(pc.yellow('[valis] Detected existing knowledge-base hooks:'));
    for (const w of warnings) {
      console.log(pc.yellow(`  • ${w}`));
    }
    console.log(pc.dim('  Valis search may compete for attention. Consider editing these files'));
    console.log(pc.dim('  to prioritize valis_search for team decision recall.'));
  }
}

export async function printSummary(config: ValisConfig, projectConfig: ProjectConfig, isJoin: boolean) {
  console.log(pc.bold('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
  console.log(pc.bold('  Setup Complete!'));
  console.log(pc.bold('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
  console.log(`\n  Org: ${pc.cyan(config.org_name)}`);
  console.log(`  Project: ${pc.cyan(projectConfig.project_name)}`);
  console.log(`  Author: ${config.author_name}`);
  if (!isJoin) {
    console.log(`\n  ${pc.bold('Invite code:')} ${pc.green(config.invite_code)}`);
    console.log(`  Share with teammates: ${pc.dim('valis init --join ' + config.invite_code)}`);
  }
  console.log(`\n  Next: Start your IDE — Valis MCP server will run automatically.`);
  console.log(`  Or run: ${pc.dim('valis serve')} to test manually.\n`);
  await detectCompetingHooks();
}

// ---------------------------------------------------------------------------
// Phase B follow-up: Memory.md migration + telemetry consent
// ---------------------------------------------------------------------------

async function ynPrompt(question: string, defaultValue: boolean): Promise<boolean> {
  return new Promise((resolve) => {
    process.stdout.write(question + ' ');
    let buf = '';
    const onData = (chunk: Buffer) => {
      buf += chunk.toString('utf-8');
      if (buf.includes('\n')) {
        process.stdin.removeListener('data', onData);
        const reply = buf.trim().toLowerCase();
        if (!reply) resolve(defaultValue);
        else if (reply.startsWith('y')) resolve(true);
        else if (reply.startsWith('n')) resolve(false);
        else resolve(defaultValue);
      }
    };
    process.stdin.on('data', onData);
  });
}

/**
 * Memory.md migration flow (T036). Detects candidates, prompts engineer,
 * on accept performs backup + stub-replace + manifest record. Skipped
 * silently in non-interactive sessions (CI, scripted installs).
 *
 * Note: Phase A ships the detection + backup + stub. Auto-import of
 * candidate entries into Valis decisions is deferred to a follow-up that
 * extends the seed pipeline; backed-up content is preserved verbatim under
 * ~/.valis/migrate-backup/<project_id>/<timestamp>/ and the engineer can
 * surface the most important entries via valis_store on demand.
 */
export async function runMemoryMigration(projectDir: string, projectId: string): Promise<void> {
  if (!process.stdin.isTTY) return;

  const migration = await import('../../hooks/migration.js');
  const telemetry = await import('../../hooks/telemetry.js');

  const candidates = await migration.detectCandidates(projectDir);
  if (candidates.length === 0) return;

  const manifest = await migration.loadManifest(projectId);
  manifest.project_name = manifest.project_name || projectId;
  const fresh = candidates.filter(
    (c) =>
      !migration.isAlreadyMigrated(c, manifest) &&
      !migration.isDeclineSuppressed(c, manifest),
  );
  if (fresh.length === 0) return;

  console.log('\n' + pc.cyan('Memory.md migration'));
  console.log(migration.renderPreview(fresh));

  void telemetry.record('migration_offered', { project_id: projectId });
  const accept = await ynPrompt(
    '\nImport into Valis? Original is backed up, replaced with a pointer.\nSkip to ask again in 30 days.\n[y/N]',
    false,
  );
  if (!accept) {
    for (const c of fresh) await migration.recordDecline(manifest, c);
    void telemetry.record('migration_declined', { project_id: projectId });
    console.log(pc.dim('  Skipped.'));
    return;
  }

  void telemetry.record('migration_accepted', { project_id: projectId });
  let succeeded = 0;
  for (const c of fresh) {
    try {
      const backupPath = await migration.backupAndStub(c, projectId);
      await migration.recordMigration(manifest, {
        candidate: c,
        backupPath,
        decisionIds: [], // Phase A: backup + stub only; entries not auto-stored
        migratedAt: new Date().toISOString(),
      });
      succeeded++;
      console.log(pc.green(`  ✓ Backed up ${c.path} → ${backupPath}`));
    } catch (err) {
      void telemetry.record('migration_failed', {
        project_id: projectId,
        error_message: (err as Error).message,
      });
      console.log(pc.yellow(`  ⚠ Failed: ${c.path} (${(err as Error).message})`));
    }
  }
  void telemetry.record('migration_completed', {
    project_id: projectId,
    metadata: { entries_migrated: succeeded },
  });
  console.log(
    pc.dim(
      `  Originals preserved under ~/.valis/migrate-backup/${projectId}/. ` +
        `Use \`valis_store\` to import the most important entries on demand.`,
    ),
  );
}

/**
 * Wrapper around runConsentDialog using stdin/stdout for the prompt.
 * Skipped silently when stdin isn't a TTY (CI, scripted installs) — in
 * that case we auto-accept the default for hosted, decline for self-hosted.
 */
export async function runTelemetryConsent(supabaseUrl: string | undefined): Promise<void> {
  const { runConsentDialog, detectSelfHosted, transitionConsent, saveConsent, loadConsent } =
    await import('../../hooks/consent.js');
  const isSelfHosted = detectSelfHosted(supabaseUrl);

  // Non-interactive auto-decision: skip the prompt, write the default record.
  if (!process.stdin.isTTY) {
    const existing = await loadConsent();
    if (existing && existing.consent_state !== 'pending') return;
    const next = transitionConsent(
      existing,
      isSelfHosted ? 'decline' : 'accept_default',
      { isSelfHosted },
    );
    await saveConsent(next);
    return;
  }

  await runConsentDialog(
    {
      show: (text: string) => {
        console.log('\n' + pc.cyan('Telemetry consent'));
        console.log(text + '\n');
      },
      ask: async (question: string, defaultValue: boolean): Promise<boolean> => {
        return new Promise((resolve) => {
          process.stdout.write(question + ' ');
          let buf = '';
          const onData = (chunk: Buffer) => {
            buf += chunk.toString('utf-8');
            if (buf.includes('\n')) {
              process.stdin.removeListener('data', onData);
              const reply = buf.trim().toLowerCase();
              if (!reply) resolve(defaultValue);
              else if (reply.startsWith('y')) resolve(true);
              else if (reply.startsWith('n')) resolve(false);
              else resolve(defaultValue);
            }
          };
          process.stdin.on('data', onData);
        });
      },
    },
    { isSelfHosted },
  );
}
