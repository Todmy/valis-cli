#!/usr/bin/env node

import { Command } from 'commander';
import { initCommand } from '../src/commands/init.js';
import { serveCommand } from '../src/commands/serve.js';
import { statusCommand } from '../src/commands/status.js';
import { dashboardCommand } from '../src/commands/dashboard.js';
import { searchCommand } from '../src/commands/search-cmd.js';
import { exportCommand } from '../src/commands/export-cmd.js';
import { configGetCommand, configSetCommand } from '../src/commands/config-cmd.js';
import { uninstallCommand } from '../src/commands/uninstall.js';
import { adminMetricsCommand } from '../src/commands/admin-metrics.js';
import { migrateAuthCommand } from '../src/commands/migrate-auth.js';
import { adminAuditCommand } from '../src/commands/admin-audit.js';
import { adminCleanupCommand } from '../src/commands/admin-cleanup.js';
import { adminPatternsCommand } from '../src/commands/admin-patterns.js';
import { enrichCommand } from '../src/commands/enrich.js';
import { upgradeCommand } from '../src/commands/upgrade.js';

const program = new Command();

program
  .name('teamind')
  .description('Shared decision intelligence for AI-augmented engineering teams')
  .version('0.1.0');

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
  .command('search <query>')
  .description('Search decisions from the terminal')
  .option('--type <type>', 'Filter by type (decision/constraint/pattern/lesson)')
  .option('--limit <n>', 'Max results (default 10)')
  .option('--all', 'Include suppressed results')
  .action(async (query, options) => {
    try {
      await searchCommand(query, options);
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`);
      process.exit(1);
    }
  });

program
  .command('export')
  .description('Export all org decisions')
  .option('--json', 'Export as JSON (default)')
  .option('--markdown', 'Export as Markdown')
  .option('--output <file>', 'Write to file instead of stdout')
  .action(async (options) => {
    try {
      await exportCommand(options);
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
  .description('Remove all local Teamind configuration')
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

program.parse();
