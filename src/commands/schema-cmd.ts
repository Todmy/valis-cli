/**
 * `valis schema` — emit a machine-readable catalog of every CLI command,
 * its arguments, options, and metadata. Designed for AI agent harnesses
 * (Cursor, Codex, Aider, Cline, Goose, OpenCode, Gemini CLI) to consume
 * once per session and build a capability map.
 *
 * Output shape is loosely modeled on clispec.dev v0.1 (April 2026), but we
 * do NOT claim full conformance — clispec is too young (per BACKLOG #150,
 * revisit when v1.0 ships with multiple consumers). The shape is stable
 * enough for any harness to write a 20-line adapter.
 *
 * Per BACKLOG #149 (0.1.4 agent-friendliness package).
 */

import type { Command, Option } from 'commander';

interface CliArgSpec {
  name: string;
  required: boolean;
  description?: string;
  variadic: boolean;
}

interface CliOptionSpec {
  flag: string;
  short?: string;
  long?: string;
  description?: string;
  required: boolean;
  hasArg: boolean;
  default?: unknown;
}

interface CliCommandSpec {
  name: string;
  description?: string;
  /**
   * `mutating: true` for commands that write to backend state (Postgres or
   * Qdrant). Agents use this to gate destructive operations behind user
   * confirmation. Conservative default: every cmd that reaches the API is
   * mutating unless explicitly listed as read-only.
   */
  mutating: boolean;
  /** Lifecycle phase — helps agents present commands in a sensible order. */
  phase: 'onboarding' | 'daily' | 'lifecycle' | 'infrastructure' | 'plan' | 'configuration' | 'operator' | 'meta';
  args: CliArgSpec[];
  options: CliOptionSpec[];
  examples: string[];
  exit_codes?: Record<number, string>;
}

interface CliCatalog {
  name: string;
  version: string;
  description: string;
  homepage?: string;
  /** Hint for harness authors — points them at the canonical docs. */
  agent_mode_flag: '--agent-mode' | '--json';
  json_output_supported: boolean;
  commands: CliCommandSpec[];
  /**
   * Hint to harness authors that the same capabilities are also available
   * over MCP. Lets a harness pick CLI vs MCP based on its own architecture.
   */
  mcp: {
    available: boolean;
    transport: 'stdio' | 'http';
    endpoint_hint: string;
    plugin_marketplace?: string;
  };
}

// ---------------------------------------------------------------------------
// Per-command static metadata that Commander doesn't carry. Keep this map
// authoritative — adding a command in bin/valis.ts without adding an entry
// here means the schema dump won't classify it (default: phase=meta, mutating=true).
// ---------------------------------------------------------------------------

const COMMAND_META: Record<
  string,
  {
    phase: CliCommandSpec['phase'];
    mutating: boolean;
    examples?: string[];
  }
> = {
  init: {
    phase: 'onboarding',
    mutating: true,
    examples: ['valis init', 'valis init --join <invite-code>'],
  },
  login: {
    phase: 'onboarding',
    mutating: true,
    examples: ['valis login'],
  },
  switch: {
    phase: 'onboarding',
    mutating: true,
    examples: ['valis switch --project frontend', 'valis switch --join <invite>'],
  },
  whoami: {
    phase: 'onboarding',
    mutating: false,
    examples: ['valis whoami'],
  },
  search: {
    phase: 'daily',
    mutating: false,
    examples: [
      'valis search "postgres"',
      'valis search "як ми обробляємо помилки"',
      'valis search "auth" --type decision --limit 5',
      'valis search "deploy" --all-projects',
    ],
  },
  index: {
    phase: 'daily',
    mutating: true,
    examples: [
      'valis index ./docs',
      'valis index ./specs --strategy section --use-git',
      'valis index ./architecture --type pattern --yes',
    ],
  },
  status: {
    phase: 'daily',
    mutating: false,
    examples: ['valis status', 'valis status --json'],
  },
  sync: {
    phase: 'daily',
    mutating: true,
    examples: ['valis sync'],
  },
  'wake-up': {
    phase: 'daily',
    mutating: false,
    examples: ['valis wake-up'],
  },
  serve: {
    phase: 'infrastructure',
    mutating: false,
    examples: ['valis serve  # stdio MCP server, used by IDE adapters'],
  },
  dashboard: {
    phase: 'infrastructure',
    mutating: false,
    examples: ['valis dashboard'],
  },
  upgrade: {
    phase: 'plan',
    mutating: true,
    examples: ['valis upgrade'],
  },
  config: {
    phase: 'configuration',
    mutating: true,
    examples: ['valis config get supabase_url', 'valis config set author_name "Alice"'],
  },
  uninstall: {
    phase: 'configuration',
    mutating: true,
    examples: ['valis uninstall --yes'],
  },
  'add-command': {
    phase: 'configuration',
    mutating: true,
    examples: ['valis add-command my-flow'],
  },
  enrich: {
    phase: 'operator',
    mutating: true,
    examples: ['valis enrich --dry-run'],
  },
  admin: {
    phase: 'operator',
    mutating: true,
    examples: ['valis admin metrics --period 30d'],
  },
  'migrate-auth': {
    phase: 'operator',
    mutating: true,
    examples: ['valis migrate-auth'],
  },
  logout: {
    phase: 'onboarding',
    mutating: true,
    examples: ['valis logout'],
  },
  schema: {
    phase: 'meta',
    mutating: false,
    examples: ['valis schema --json', 'valis schema --json | jq ".commands[] | .name"'],
  },
  workflows: {
    phase: 'meta',
    mutating: false,
    examples: ['valis workflows'],
  },
  mcp: {
    phase: 'meta',
    mutating: false,
    examples: ['valis mcp'],
  },
};

// ---------------------------------------------------------------------------
// Walk the Commander program tree and emit the catalog.
// ---------------------------------------------------------------------------

function commandToSpec(cmd: Command): CliCommandSpec {
  const name = cmd.name();
  const meta = COMMAND_META[name] ?? { phase: 'meta' as const, mutating: true };

  const args: CliArgSpec[] = [];
  // commander internal property — guarded against future API changes
  const cmdArgs = (cmd as unknown as { _args?: Array<{ name: string; required: boolean; description?: string; variadic?: boolean }> })._args ?? [];
  for (const a of cmdArgs) {
    args.push({
      name: a.name,
      required: a.required,
      description: a.description || undefined,
      variadic: a.variadic ?? false,
    });
  }

  const options: CliOptionSpec[] = cmd.options.map((opt: Option) => ({
    flag: opt.flags,
    short: opt.short || undefined,
    long: opt.long || undefined,
    description: opt.description || undefined,
    required: opt.required,
    hasArg: opt.flags.includes('<') || opt.flags.includes('['),
    default: opt.defaultValue,
  }));

  return {
    name,
    description: cmd.description() || undefined,
    mutating: meta.mutating,
    phase: meta.phase,
    args,
    options,
    examples: meta.examples ?? [],
    exit_codes: { 0: 'success', 1: 'error (auth, config, validation, or backend-thrown)' },
  };
}

export function buildCatalog(rootProgram: Command): CliCatalog {
  const commands: CliCommandSpec[] = [];

  for (const sub of rootProgram.commands) {
    commands.push(commandToSpec(sub));
    // include nested subcommands (e.g. config get/set, admin metrics)
    if (sub.commands.length > 0) {
      for (const nested of sub.commands) {
        const spec = commandToSpec(nested);
        spec.name = `${sub.name()} ${nested.name()}`;
        commands.push(spec);
      }
    }
  }

  return {
    name: 'valis',
    version: rootProgram.version() || 'unknown',
    description:
      'Shared decision intelligence for AI-augmented engineering teams. Universal CLI — works alongside any AI coding agent.',
    homepage: 'https://valis.krukit.co',
    agent_mode_flag: '--agent-mode',
    json_output_supported: true,
    commands,
    mcp: {
      available: true,
      transport: 'http',
      endpoint_hint: 'https://valis.krukit.co/api/mcp (OAuth 2.1) or `valis serve` for local stdio',
      plugin_marketplace: 'github.com/Todmy/valis-plugin (Claude Code marketplace)',
    },
  };
}

// ---------------------------------------------------------------------------
// Command entry point
// ---------------------------------------------------------------------------

export async function schemaCommand(rootProgram: Command, options: { format?: 'json' | 'yaml' }): Promise<void> {
  const catalog = buildCatalog(rootProgram);

  // YAML support is a nice-to-have; for now we emit JSON only and the
  // --format flag exists as an extension point (per BACKLOG #150 we'll
  // revisit clispec full conformance which mandates YAML support).
  if (options.format && options.format !== 'json') {
    console.error(
      `Error: --format=${options.format} not supported yet. Currently only JSON is emitted.`,
    );
    process.exit(2);
  }

  console.log(JSON.stringify(catalog, null, 2));
}
