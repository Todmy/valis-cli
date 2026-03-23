import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import pc from 'picocolors';
import { loadConfig, saveConfig, getConfigDir } from '../config/store.js';
import { trackFile } from '../config/manifest.js';
import { detectIDEs } from '../ide/detect.js';
import { configureClaudeCodeMCP, injectClaudeMdMarkers } from '../ide/claude-code.js';
import { configureCodexMCP, injectAgentsMdMarkers } from '../ide/codex.js';
import { runSeed } from '../seed/index.js';
import { getSupabaseClient } from '../cloud/supabase.js';
import { getQdrantClient, ensureCollection } from '../cloud/qdrant.js';
import { storeDecision } from '../cloud/supabase.js';
import { upsertDecision, hybridSearch } from '../cloud/qdrant.js';
import type { TeamindConfig } from '../types.js';

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
  }>;
}

export async function initCommand(options: { join?: string }): Promise<void> {
  console.log(pc.bold('\n🧠 Teamind Setup\n'));

  const existing = await loadConfig();
  if (existing) {
    console.log(pc.yellow('Teamind is already configured for this machine.'));
    console.log(`  Org: ${existing.org_name}`);
    console.log(`  Author: ${existing.author_name}`);
    const answer = await prompt('Reconfigure? (y/N) ');
    if (answer.toLowerCase() !== 'y') {
      console.log('Aborted.');
      return;
    }
  }

  // Get Supabase credentials
  const supabaseUrl = process.env.SUPABASE_URL || await prompt('Supabase URL: ');
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || await prompt('Supabase Service Role Key: ');
  const qdrantUrl = process.env.QDRANT_URL || await prompt('Qdrant URL: ');
  const qdrantApiKey = process.env.QDRANT_API_KEY || await prompt('Qdrant API Key: ');

  let config: TeamindConfig;

  if (options.join) {
    // Join existing org
    console.log(pc.cyan(`\nJoining org with invite code: ${options.join}`));
    const authorName = await prompt('Your name: ');

    const result = await joinOrg(supabaseUrl, serviceRoleKey, options.join, authorName);
    console.log(pc.green(`✓ Joined "${result.org_name}" (${result.member_count} members)`));
    console.log(`  ${result.decision_count} decisions already available`);

    config = {
      org_id: result.org_id,
      org_name: result.org_name,
      api_key: result.api_key,
      invite_code: options.join,
      author_name: authorName,
      supabase_url: supabaseUrl,
      supabase_service_role_key: serviceRoleKey,
      qdrant_url: qdrantUrl,
      qdrant_api_key: qdrantApiKey,
      configured_ides: [],
      created_at: new Date().toISOString(),
    };
  } else {
    // Create new org
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
    };
  }

  // Save config
  await saveConfig(config);
  await trackFile({ type: 'config_dir', path: getConfigDir() });
  console.log(pc.green('✓ Config saved'));

  // Detect and configure IDEs
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
    }
  }

  config.configured_ides = detectedNames;
  await saveConfig(config);

  if (detectedNames.length === 0) {
    console.log(pc.yellow('  No supported IDEs detected. Configure manually later.'));
  }

  // Ensure Qdrant collection
  console.log(pc.cyan('\nInitializing search index...'));
  const qdrant = getQdrantClient(qdrantUrl, qdrantApiKey);
  try {
    await ensureCollection(qdrant);
    console.log(pc.green('✓ Qdrant collection ready'));
  } catch (err) {
    console.log(pc.yellow(`⚠ Qdrant setup skipped: ${(err as Error).message}`));
  }

  // Seed brain (only for new orgs)
  if (!options.join) {
    console.log(pc.cyan('\nSeeding team brain...'));
    const supabase = getSupabaseClient(supabaseUrl, serviceRoleKey);

    try {
      const seedResult = await runSeed(
        process.cwd(),
        config.org_id,
        config.author_name,
        supabase,
        qdrant,
      );
      console.log(pc.green(`✓ Seeded ${seedResult.stored} decisions from ${Object.keys(seedResult.sources).join(', ') || 'sources'}`));
    } catch (err) {
      console.log(pc.yellow(`⚠ Seed skipped: ${(err as Error).message}`));
    }

    // Verification round-trip
    console.log(pc.cyan('\nVerifying round-trip...'));
    try {
      const supabase = getSupabaseClient(supabaseUrl, serviceRoleKey);
      const testDecision = await storeDecision(
        supabase,
        config.org_id,
        { text: 'Teamind initialized successfully — this is a verification decision' },
        config.author_name,
        'seed',
      );
      await upsertDecision(qdrant, config.org_id, testDecision.id, {
        text: 'Teamind initialized successfully — this is a verification decision',
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

  // Print invite code
  console.log(pc.bold('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
  console.log(pc.bold('  Setup Complete!'));
  console.log(pc.bold('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
  console.log(`\n  Org: ${pc.cyan(config.org_name)}`);
  console.log(`  Author: ${config.author_name}`);
  if (!options.join) {
    console.log(`\n  ${pc.bold('Invite code:')} ${pc.green(config.invite_code)}`);
    console.log(`  Share with teammates: ${pc.dim('teamind init --join ' + config.invite_code)}`);
  }
  console.log(`\n  Next: Start your IDE — Teamind MCP server will run automatically.`);
  console.log(`  Or run: ${pc.dim('teamind serve')} to test manually.\n`);
}
