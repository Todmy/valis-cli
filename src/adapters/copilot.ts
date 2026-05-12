/**
 * GitHub Copilot adapter — VS Code Copilot + Copilot CLI.
 *
 *   - MCP config: VS Code user-profile mcp.json (top-level "servers" — NOT "mcpServers")
 *     - macOS:   ~/Library/Application Support/Code/User/mcp.json
 *     - Linux:   ~/.config/Code/User/mcp.json
 *     - Windows: %APPDATA%/Code/User/mcp.json
 *   - CLI plugins: ~/.copilot/installed-plugins/<marketplace>/<plugin>/
 *   - VS Code agent plugins: ~/.vscode/agent-plugins/<domain>/<owner>/<repo>/
 *   - Hooks: ~/.copilot/hooks/*.json (global), .github/hooks/*.json (project)
 *
 * Note: Copilot's MCP config uses `"servers"` top-level key, distinct from
 * Claude/Cursor/Gemini's `"mcpServers"`. Deployer dispatches by `mcpFormat()`.
 *
 * Windows path TODO — Node `process.platform === 'win32'` branch not yet
 * implemented. macOS + Linux only for the first cut.
 *
 * Adapted from HarnessKit's `hk-core/src/adapter/copilot.rs` (Apache-2.0).
 */

import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import type {
  ConfigScope,
  HookEntry,
  HookFormat,
  McpFormat,
  McpServerEntry,
  ProjectMarker,
} from './types.js';
import { projectMarkerDir } from './types.js';
import type { HarnessAdapter } from './index.js';
import type { HarnessName } from './hook-events.js';
import { pathExists, parseJson } from './_util.js';

const HOME = homedir();

function vscodeUserDir(): string {
  switch (platform()) {
    case 'darwin':
      return join(HOME, 'Library', 'Application Support', 'Code', 'User');
    case 'win32':
      // TODO: prefer process.env.APPDATA; falling back for now.
      return join(HOME, 'AppData', 'Roaming', 'Code', 'User');
    default:
      return join(HOME, '.config', 'Code', 'User');
  }
}

const COPILOT_DIR = join(HOME, '.copilot');

interface RawCopilotMcp {
  servers?: Record<
    string,
    { command?: unknown; args?: unknown; env?: Record<string, unknown> }
  >;
}

export const copilotAdapter: HarnessAdapter = {
  name: 'copilot' as HarnessName,
  baseDir: () => COPILOT_DIR,
  detect: async () => (await pathExists(COPILOT_DIR)) || pathExists(vscodeUserDir()),
  skillDirs: () => [join(COPILOT_DIR, 'skills'), join(HOME, '.agents', 'skills')],
  mcpConfigPath: () => join(vscodeUserDir(), 'mcp.json'),
  hookConfigPath: () => join(COPILOT_DIR, 'hooks'),
  pluginDirs: () => [join(COPILOT_DIR, 'installed-plugins'), join(HOME, '.vscode', 'agent-plugins')],
  hookFormat: (): HookFormat => 'Copilot',
  mcpFormat: (): McpFormat => 'Servers',
  needsPathInjection: () => false,

  async readMcpServers(): Promise<McpServerEntry[]> {
    const raw = await parseJson<RawCopilotMcp>(this.mcpConfigPath());
    const servers = raw?.servers;
    if (!servers) return [];
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
                (e): e is [string, string] => typeof e[1] === 'string',
              ),
            )
          : {},
      enabled: true,
    }));
  },

  async readHooks(): Promise<HookEntry[]> {
    // Copilot hooks live as one JSON file per event in ~/.copilot/hooks/*.json
    // Reader implementation deferred — Valis writes only on install.
    return [];
  },

  projectMarkers: (): ProjectMarker[] => [projectMarkerDir('.github')],
  projectSkillDirs: () => ['.github/skills'],
  projectMcpConfigRelpath: () => '.vscode/mcp.json',
  projectHookConfigRelpath: () => '.github/hooks',

  globalRulesFiles: () => [],
  projectRulesPatterns: () => ['.github/copilot-instructions.md', 'AGENTS.md'],
  projectSettingsPatterns: () => ['.vscode/mcp.json', '.github/hooks/*.json'],

  mcpConfigPathFor(scope: ConfigScope) {
    if (scope.kind === 'global') return this.mcpConfigPath();
    const rel = this.projectMcpConfigRelpath();
    return rel ? join(scope.path, rel) : undefined;
  },
  hookConfigPathFor(scope: ConfigScope) {
    if (scope.kind === 'global') return this.hookConfigPath();
    const rel = this.projectHookConfigRelpath();
    return rel ? join(scope.path, rel) : undefined;
  },
  skillDirFor(scope: ConfigScope) {
    if (scope.kind === 'global') return this.skillDirs()[0];
    const rel = this.projectSkillDirs()[0];
    return rel ? join(scope.path, rel) : undefined;
  },
};
