#!/usr/bin/env node

import { Command } from 'commander';
import { VERSION } from '../src/index.js';
import { initCommand } from '../src/commands/init.js';
import { serveCommand } from '../src/commands/serve.js';
import { statusCommand } from '../src/commands/status.js';
import { dashboardCommand } from '../src/commands/dashboard.js';
import { searchCommand } from '../src/commands/search-cmd.js';
import { configGetCommand, configSetCommand } from '../src/commands/config-cmd.js';
import { uninstallCommand } from '../src/commands/uninstall.js';
import { adminMetricsCommand } from '../src/commands/admin-metrics.js';
import { migrateAuthCommand } from '../src/commands/migrate-auth.js';
import { adminAuditCommand } from '../src/commands/admin-audit.js';
import { adminCleanupCommand } from '../src/commands/admin-cleanup.js';
import { adminPatternsCommand } from '../src/commands/admin-patterns.js';
import { adminMigrateQdrantCommand } from '../src/commands/admin-migrate-qdrant.js';
import { adminReindexCommand } from '../src/commands/admin-reindex.js';
import { adminClustersCommand } from '../src/commands/admin-clusters.js';
import { adminConsolidateCommand } from '../src/commands/admin-consolidate.js';
import { enrichCommand } from '../src/commands/enrich.js';
import { upgradeCommand } from '../src/commands/upgrade.js';
import { switchOrgCommand } from '../src/commands/switch-org.js';
import { switchCommand } from '../src/commands/switch.js';
import { loginCommand } from '../src/commands/login.js';
import { logoutCommand } from '../src/commands/logout.js';
import { whoamiCommand } from '../src/commands/whoami.js';
import { syncCommand } from '../src/commands/sync.js';
import { wakeUpCommand } from '../src/commands/wake-up.js';
import {
  hookSessionStartCommand,
  hookUserPromptSubmitCommand,
  hookPostToolUseCommand,
  hookPreToolUseCommand,
  hookPreCompactCommand,
  hookStopCommand,
} from '../src/commands/hook.js';
import { addCommandCommand } from '../src/commands/add-command.js';
import { indexCommand } from '../src/commands/index-cmd.js';
import { schemaCommand } from '../src/commands/schema-cmd.js';
import { helpTopicCommand } from '../src/commands/help-topics.js';

const program = new Command();

program
  .name('valis')
  .description(
    'Shared decision intelligence for AI-augmented engineering teams.\n' +
      '\n' +
      'Universal CLI — works alongside any AI coding agent (Claude Code,\n' +
      'Cursor, Codex, Aider, Cline, Goose, OpenCode, Gemini CLI). Captures,\n' +
      'searches, and enforces architectural decisions across sessions.',
  )
  .version(VERSION)
  .option('--json', 'Emit machine-readable JSON output (auto-enabled when stdout is not a TTY)')
  .option('--agent-mode', 'Alias for --json. Disables TTY heuristics; always structured output');

// 0.1.4: groupings + footer for `valis --help`. Per BACKLOG #149.
//
// Commander's flat command listing is alphabetic by registration order
// and not navigable for agents skimming `--help`. `.addHelpText('after', ...)`
// appends a phase-grouped catalog AFTER the alphabetic list — agents and
// humans both can scan groups instead of 21 commands in one column.
program.addHelpText(
  'after',
  `

GROUPED BY PHASE
  Onboarding       init · login · switch · whoami
  Daily use        search · index · status · sync · wake-up
  Lifecycle        (use the MCP tools or the dashboard for promote/deprecate/pin)
  Infrastructure   serve · dashboard
  Plan & billing   upgrade
  Configuration    config get/set · add-command · uninstall
  Operator         enrich · admin · migrate-auth

GETTING STARTED
  $ valis init                        # first time: create or join an org
  $ valis index ./docs                # then: bulk-import existing markdown
  $ valis search "postgres"           # then: query the team brain

AGENT INTEGRATION
  $ valis schema --json               # machine-readable command catalog
  $ valis --agent-mode <command>      # structured JSON output for any cmd
  $ valis mcp                         # how CLI commands map to MCP tools
  $ valis workflows                   # canonical multi-step flows

  Cross-harness adapter: any agent harness can shell out to the CLI and
  parse \`valis schema --json\` to discover commands. The plugin (Claude
  Code marketplace) is the convenience layer — CLI is the substrate.

NEXT
  valis help <command>                # detailed help + examples per command
  https://valis.krukit.co/docs        # full documentation
`,
);

program
  .command('init')
  .description('Create or join an organization and configure the local environment')
  .option('--join <invite-code>', 'Join an existing org with invite code')
  .action(async (options) => {
    try {
      await initCommand(options);
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`);
      process.exit(1);
    }
  });

program
  .command('switch')
  .description('Switch org (--join) or project (--project) for the current directory')
  .option('--join <invite-code>', 'Invite code for the org to join')
  .option('--project <name-or-id>', 'Project name or UUID to switch to')
  .action(async (options) => {
    try {
      if (options.join) {
        await switchOrgCommand(options);
      } else {
        // --project flag or interactive mode
        await switchCommand(options);
      }
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`);
      process.exit(1);
    }
  });

program
  .command('serve')
  .description('Start the unified MCP + Channel server process')
  .action(async () => {
    try {
      await serveCommand();
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`);
      process.exit(1);
    }
  });

program
  .command('status')
  .description('Show system health and org info')
  .action(async () => {
    try {
      await statusCommand();
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`);
      process.exit(1);
    }
  });

program
  .command('dashboard')
  .description('Show aggregated team activity')
  .action(async () => {
    try {
      await dashboardCommand();
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`);
      process.exit(1);
    }
  });

program
  .command('index <folder>')
  .description('Bulk-import markdown documentation as decisions (interactive)')
  // 0.1.10: dropped --mode/--strategy. One file → one decision; body is
  // chunked at Qdrant ingestion. See `valis help index` for rationale.
  .option('--enrich', 'After import, also run LLM enrichment (~$0.18 per 1k drafts with Haiku)')
  .option('--use-git', 'Extract author + first-commit-time from git log (skip prompt)')
  .option('--type <type>', 'Default decision type when filename prefix is missing (skip prompt)')
  .option('--affects <tags>', 'Comma-separated tags applied to every decision (skip prompt)')
  .option('--dry-run', 'Preview only, no writes')
  .option('--yes', 'Skip ALL prompts; use defaults (no-enrich / no-git / decision / no-affects)')
  .action(async (folder, options) => {
    try {
      await indexCommand(folder, options);
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`);
      process.exit(1);
    }
  });

program
  .command('search <query>')
  .description('Search decisions from the terminal')
  .option('--type <type>', 'Filter by type (decision/constraint/pattern/lesson)')
  .option('--limit <n>', 'Max results (default 10)')
  .option('--all', 'Include suppressed results')
  .option('--all-projects', 'Search across all accessible projects')
  .action(async (query, options) => {
    try {
      await searchCommand(query, options);
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`);
      process.exit(1);
    }
  });

const configCmd = program
  .command('config')
  .description('Manage configuration');

configCmd
  .command('get <key>')
  .description('Get a config value')
  .action(async (key) => {
    try {
      await configGetCommand(key);
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`);
      process.exit(1);
    }
  });

configCmd
  .command('set <key> <value>')
  .description('Set a config value')
  .action(async (key, value) => {
    try {
      await configSetCommand(key, value);
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`);
      process.exit(1);
    }
  });

program
  .command('uninstall')
  .description('Remove all local Valis configuration')
  .option('--yes', 'Skip confirmation prompt')
  .action(async (options) => {
    try {
      await uninstallCommand(options);
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`);
      process.exit(1);
    }
  });

program
  .command('migrate-auth')
  .description('Migrate from org-level to per-member JWT auth')
  .action(async () => {
    try {
      await migrateAuthCommand();
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`);
      process.exit(1);
    }
  });

program
  .command('enrich')
  .description('Classify pending decisions using LLM enrichment')
  .option('--dry-run', 'Show what would be enriched without making changes')
  .option('--provider <provider>', 'LLM provider to use (anthropic|openai)')
  .option('--ceiling <dollars>', 'Daily cost ceiling in dollars (default: 1.00)')
  .action(async (options) => {
    try {
      await enrichCommand(options);
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`);
      process.exit(1);
    }
  });

const adminCmd = program
  .command('admin')
  .description('Platform operator commands');

adminCmd
  .command('metrics')
  .description('Show platform-wide observability metrics')
  .option('--json', 'Output raw JSON instead of formatted table')
  .option('--period <period>', 'Time period: 7d or 30d (default: 7d)')
  .action(async (options) => {
    try {
      await adminMetricsCommand(options);
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`);
      process.exit(1);
    }
  });

adminCmd
  .command('audit')
  .description('View audit trail for an org')
  .option('--org <org-id>', 'Target org ID (defaults to local config)')
  .option('--member <author>', 'Filter by member/author name')
  .option('--limit <n>', 'Max rows (default 50)')
  .action(async (options) => {
    try {
      await adminAuditCommand(options);
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`);
      process.exit(1);
    }
  });

adminCmd
  .command('cleanup')
  .description('Detect and clean up duplicate and orphaned decisions')
  .option('--dry-run', 'Report findings without making changes (default)')
  .option('--apply', 'Execute cleanup actions (deprecate exact dupes, create audit entries)')
  .option('--org <org-id>', 'Target org ID (defaults to local config)')
  .action(async (options) => {
    try {
      await adminCleanupCommand(options);
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`);
      process.exit(1);
    }
  });

adminCmd
  .command('patterns')
  .description('Detect and synthesize patterns from decision clusters')
  .option('--window <days>', 'Time window for clustering in days (default 30)')
  .option('--min-cluster <n>', 'Minimum decisions per cluster (default 3)')
  .option('--dry-run', 'Report patterns without creating decisions')
  .option('--org <org-id>', 'Target org ID (defaults to local config)')
  .action(async (options) => {
    try {
      await adminPatternsCommand(options);
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`);
      process.exit(1);
    }
  });

adminCmd
  .command('migrate-qdrant')
  .description('Backfill project_id into Qdrant points missing it')
  .option('--dry-run', 'Report findings without making changes')
  .action(async (options) => {
    try {
      await adminMigrateQdrantCommand(options);
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`);
      process.exit(1);
    }
  });

adminCmd
  .command('reindex')
  .description('Re-embed all decisions in the active org (backfill embeddings)')
  .option('--dry-run', 'Scan only — do not write any changes', false)
  .action(async (options) => {
    try {
      await adminReindexCommand(options);
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`);
      process.exit(1);
    }
  });

adminCmd
  .command('clusters')
  .description('View and manage decision clusters')
  .option('--detail', 'Show member decisions for each cluster')
  .option('--merge <ids...>', 'Merge cluster B into cluster A (provide two IDs)')
  .action(async (options) => {
    try {
      await adminClustersCommand(options);
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`);
      process.exit(1);
    }
  });

adminCmd
  .command('consolidate')
  .description('Review and merge semantically similar decisions')
  .option('--dry-run', 'Show groups without making changes (default)')
  .option('--auto-merge', 'Execute merge for high-similarity groups (>0.9)')
  .option('--threshold <n>', 'Cosine similarity threshold for grouping (default 0.7)')
  .option('--org <org-id>', 'Target org ID (defaults to local config)')
  .action(async (options) => {
    try {
      await adminConsolidateCommand(options);
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`);
      process.exit(1);
    }
  });

program
  .command('upgrade')
  .description('Upgrade your organization plan via Stripe Checkout')
  .option('--plan <plan>', 'Target plan: team or business (default: team)')
  .option('--annual', 'Use annual billing (default: monthly)')
  .action(async (options) => {
    try {
      await upgradeCommand(options);
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`);
      process.exit(1);
    }
  });

program
  .command('login')
  .description('Authenticate with Valis Cloud')
  .option('--api-key', 'Login with API key instead of browser')
  .action(async (options: { apiKey?: boolean }) => {
    try {
      await loginCommand(options);
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`);
      process.exit(1);
    }
  });

program
  .command('logout')
  .description('Remove stored credentials')
  .action(async () => {
    try {
      await logoutCommand();
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`);
      process.exit(1);
    }
  });

program
  .command('whoami')
  .description('Show current authenticated identity')
  .action(async () => {
    try {
      await whoamiCommand();
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`);
      process.exit(1);
    }
  });

program
  .command('sync')
  .description('Sync offline queue to cloud')
  .action(async () => {
    try {
      await syncCommand();
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`);
      process.exit(1);
    }
  });

program
  .command('wake-up')
  .description('Show recent team activity and decisions')
  .action(async () => {
    try {
      await wakeUpCommand();
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`);
      process.exit(1);
    }
  });

// Internal hook subcommands — called by Claude Code hooks, not user-facing
const hookCmd = new Command('hook')
  .description('Internal hook commands (used by Claude Code)');
program.addCommand(hookCmd, { hidden: true });

hookCmd
  .command('session-start')
  .description('SessionStart hook: inject team context into session')
  .action(async () => {
    try {
      await hookSessionStartCommand();
    } catch {
      // Hooks must never crash — silent exit on any error
      process.exit(0);
    }
  });

hookCmd
  .command('user-prompt-submit')
  .description('UserPromptSubmit hook: always-inject per-prompt augmentation (Phase A US2)')
  .action(async () => {
    try {
      await hookUserPromptSubmitCommand();
    } catch {
      process.exit(0);
    }
  });

hookCmd
  .command('post-tool-use')
  .description('PostToolUse hook: own-write cache invalidation (Phase A FR-006a)')
  .action(async () => {
    try {
      await hookPostToolUseCommand();
    } catch {
      process.exit(0);
    }
  });

hookCmd
  .command('pre-tool-use')
  .description('PreToolUse hook: silent stub (Phase B FR-040 — telemetry-gated)')
  .action(async () => {
    try {
      await hookPreToolUseCommand();
    } catch {
      process.exit(0);
    }
  });

hookCmd
  .command('pre-compact')
  .description('PreCompact hook: silent stub (Phase B FR-042 — telemetry-gated)')
  .action(async () => {
    try {
      await hookPreCompactCommand();
    } catch {
      process.exit(0);
    }
  });

hookCmd
  .command('stop')
  .description('Stop hook: silent stub (Phase B FR-042 — telemetry-gated)')
  .action(async () => {
    try {
      await hookStopCommand();
    } catch {
      process.exit(0);
    }
  });

program
  .command('add-command [name]')
  .description('Create a custom /valis-* slash command')
  .action(async (name) => {
    try {
      await addCommandCommand(name);
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`);
      process.exit(1);
    }
  });

// 0.1.4: agent-discovery primitives. Per BACKLOG #149.
program
  .command('schema')
  .description('Emit a machine-readable JSON catalog of every CLI command (for harness adapters)')
  .option('--format <fmt>', 'Output format. Currently only json is supported.', 'json')
  .action(async (options) => {
    try {
      await schemaCommand(program, { format: options.format });
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`);
      process.exit(1);
    }
  });

program
  .command('workflows')
  .description('Show canonical multi-step flows (onboarding, capture loop, lifecycle, ...)')
  .action(async () => {
    try {
      await helpTopicCommand('workflows');
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`);
      process.exit(1);
    }
  });

program
  .command('mcp')
  .description('Show CLI ↔ MCP tool mapping and how harnesses pick CLI vs MCP')
  .action(async () => {
    try {
      await helpTopicCommand('mcp');
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`);
      process.exit(1);
    }
  });

program.parse();
