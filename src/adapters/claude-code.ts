/**
 * Claude Code adapter — reference implementation of `HarnessAdapter`.
 *
 * Sources of truth:
 *   - MCP config:        ~/.claude.json (top-level "mcpServers")
 *   - Settings + hooks:  ~/.claude/settings.json
 *   - Plugins:           ~/.claude/plugins/ + .claude-plugin/plugin.json manifests
 *   - Skills:            ~/.claude/skills/
 *
 * Docs:
 *   - MCP:     https://code.claude.com/docs/en/mcp
 *   - Plugins: https://code.claude.com/docs/en/plugins
 *   - Hooks:   https://code.claude.com/docs/en/hooks
 *
 * The complementary action helpers (`configureClaudeCodeMCP`, `injectClaudeMdMarkers`,
 * `scaffoldBuiltInCommands`) still live in `../ide/claude-code.ts` — this module
 * is the data-first companion. Migration plan: once all eight harnesses have
 * their adapter declared here, `../ide/setupIDEs` switches over to walking
 * adapters and doing generic install/inject through a shared deployer.
 *
 * Adapted from HarnessKit's `hk-core/src/adapter/claude.rs` (Apache-2.0).
 */

import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type {
  ConfigScope,
  HookEntry,
  HookFormat,
  McpFormat,
  McpServerEntry,
  ProjectMarker,
} from './types.js';
import { projectMarkerDir, projectMarkerFile } from './types.js';
import type { HarnessAdapter } from './index.js';
import type { HarnessName } from './hook-events.js';

const HOME = homedir();
const BASE_DIR = join(HOME, '.claude');

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function parseJson<T = unknown>(path: string): Promise<T | undefined> {
  try {
    const content = await fs.readFile(path, 'utf-8');
    return JSON.parse(content) as T;
  } catch {
    return undefined;
  }
}

export const claudeCodeAdapter: HarnessAdapter = {
  name: 'claude-code' as HarnessName,

  baseDir(): string {
    return BASE_DIR;
  },

  async detect(): Promise<boolean> {
    return pathExists(BASE_DIR);
  },

  skillDirs(): string[] {
    return [join(BASE_DIR, 'skills')];
  },

  mcpConfigPath(): string {
    // MCP servers live in ~/.claude.json, NOT settings.json — a Claude quirk.
    return join(HOME, '.claude.json');
  },

  hookConfigPath(): string {
    return join(BASE_DIR, 'settings.json');
  },

  pluginDirs(): string[] {
    return [join(BASE_DIR, 'plugins')];
  },

  hookFormat(): HookFormat {
    return 'ClaudeLike';
  },

  mcpFormat(): McpFormat {
    return 'McpServers';
  },

  needsPathInjection(): boolean {
    // CLI-launched; inherits shell PATH.
    return false;
  },

  async readMcpServers(): Promise<McpServerEntry[]> {
    return this.readMcpServersFrom!(this.mcpConfigPath());
  },

  async readMcpServersFrom(path: string): Promise<McpServerEntry[]> {
    const settings = await parseJson<{ mcpServers?: Record<string, RawMcpServer> }>(path);
    const servers = settings?.mcpServers;
    if (!servers || typeof servers !== 'object') return [];

    return Object.entries(servers).map(([name, val]) => ({
      name,
      command: typeof val?.command === 'string' ? val.command : '',
      args: Array.isArray(val?.args)
        ? val.args.filter((a): a is string => typeof a === 'string')
        : [],
      env:
        val?.env && typeof val.env === 'object'
          ? Object.fromEntries(
              Object.entries(val.env).filter(
                (entry): entry is [string, string] => typeof entry[1] === 'string',
              ),
            )
          : {},
      // Claude's MCP schema has no agent-native disable concept.
      enabled: true,
    }));
  },

  async readHooks(): Promise<HookEntry[]> {
    return this.readHooksFrom!(this.hookConfigPath());
  },

  async readHooksFrom(path: string): Promise<HookEntry[]> {
    const settings = await parseJson<{ hooks?: Record<string, RawHookEntry[]> }>(path);
    const hooks = settings?.hooks;
    if (!hooks || typeof hooks !== 'object') return [];

    const out: HookEntry[] = [];
    for (const [event, hookList] of Object.entries(hooks)) {
      if (!Array.isArray(hookList)) continue;
      for (const hook of hookList) {
        const matcher = typeof hook?.matcher === 'string' ? hook.matcher : undefined;
        if (!Array.isArray(hook?.hooks)) continue;
        for (const cmd of hook.hooks) {
          // Claude's hook array entries come in three shapes:
          //   1. plain string:   "echo test"
          //   2. command object: { type: "command", command: "echo test" }
          //   3. prompt object:  { type: "prompt", prompt: "..." }
          const command =
            typeof cmd === 'string'
              ? cmd
              : typeof cmd?.command === 'string'
                ? cmd.command
                : typeof cmd?.prompt === 'string'
                  ? cmd.prompt
                  : undefined;
          if (command) {
            out.push({ event, matcher, command });
          }
        }
      }
    }
    return out;
  },

  projectMarkers(): ProjectMarker[] {
    return [projectMarkerDir('.claude'), projectMarkerFile('.mcp.json')];
  },

  projectSkillDirs(): string[] {
    return ['.claude/skills'];
  },

  projectMcpConfigRelpath(): string | undefined {
    return '.mcp.json';
  },

  projectHookConfigRelpath(): string | undefined {
    // Project hooks live in `.claude/settings.json` alongside other settings.
    return '.claude/settings.json';
  },

  globalRulesFiles(): string[] {
    // Claude scans ~/.claude/CLAUDE.md and ~/.claude/rules/*.md.
    // The directory scan happens in inspection code; we expose the seed file.
    return [join(BASE_DIR, 'CLAUDE.md')];
  },

  projectRulesPatterns(): string[] {
    return ['CLAUDE.md', '.claude/CLAUDE.md', '.claude/rules/*.md'];
  },

  projectSettingsPatterns(): string[] {
    return [
      '.claude/settings.json',
      '.claude/settings.local.json',
      '.mcp.json',
    ];
  },

  mcpConfigPathFor(scope: ConfigScope): string | undefined {
    if (scope.kind === 'global') return this.mcpConfigPath();
    const rel = this.projectMcpConfigRelpath();
    return rel ? join(scope.path, rel) : undefined;
  },

  hookConfigPathFor(scope: ConfigScope): string | undefined {
    if (scope.kind === 'global') return this.hookConfigPath();
    const rel = this.projectHookConfigRelpath();
    return rel ? join(scope.path, rel) : undefined;
  },

  skillDirFor(scope: ConfigScope): string | undefined {
    if (scope.kind === 'global') return this.skillDirs()[0];
    const rel = this.projectSkillDirs()[0];
    return rel ? join(scope.path, rel) : undefined;
  },
};

// ---------------------------------------------------------------------------
// Internal raw-input types — what we read off disk before normalising
// ---------------------------------------------------------------------------

interface RawMcpServer {
  command?: unknown;
  args?: unknown;
  env?: Record<string, unknown>;
}

interface RawHookEntry {
  matcher?: unknown;
  hooks?: unknown;
}
