/**
 * Antigravity adapter — Google's VS-Code-fork agent IDE.
 *
 *   - Base dir:     ~/.gemini/antigravity (AI runtime data; NOT ~/.antigravity which is IDE shell)
 *   - MCP config:   ~/.gemini/antigravity/mcp_config.json
 *   - Hooks:        not supported → `hookFormat: 'None'` (use rules instead)
 *   - Plugins:      none
 *
 * GUI-launched → `needsPathInjection: true`.
 *
 * Project skill dirs: Antigravity 1.18.4+ migrated `.agent/` → `.agents/` —
 * both still load but `.agents/` is canonical. Order matters: list canonical
 * first so single-pick callers (`projectSkillDirs()[0]`) get the canonical
 * location.
 *
 * Adapted from HarnessKit's `hk-core/src/adapter/antigravity.rs` (Apache-2.0).
 */

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
import { projectMarkerDir } from './types.js';
import type { HarnessAdapter } from './index.js';
import type { HarnessName } from './hook-events.js';
import { pathExists, parseJson } from './_util.js';

const HOME = homedir();
const BASE_DIR = join(HOME, '.gemini', 'antigravity');

interface RawAntigravityMcp {
  mcpServers?: Record<
    string,
    { command?: unknown; args?: unknown; env?: Record<string, unknown> }
  >;
}

export const antigravityAdapter: HarnessAdapter = {
  name: 'antigravity' as HarnessName,
  baseDir: () => BASE_DIR,
  detect: async () => pathExists(BASE_DIR),
  skillDirs: () => [join(BASE_DIR, 'skills')], // Antigravity does NOT scan ~/.agents/skills
  mcpConfigPath: () => join(BASE_DIR, 'mcp_config.json'),
  hookConfigPath: () => join(BASE_DIR, '.hooks.unused'), // placeholder; never read/written
  pluginDirs: () => [],
  hookFormat: (): HookFormat => 'None', // no hook system — use rules
  mcpFormat: (): McpFormat => 'McpServers',
  needsPathInjection: () => true, // GUI-launched

  async readMcpServers(): Promise<McpServerEntry[]> {
    const raw = await parseJson<RawAntigravityMcp>(this.mcpConfigPath());
    const servers = raw?.mcpServers;
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
    return []; // no hook system
  },

  projectMarkers: (): ProjectMarker[] => [
    projectMarkerDir('.agents'),
    projectMarkerDir('.agent'),
  ],
  // .agents canonical (1.18.4+); .agent legacy still loaded
  projectSkillDirs: () => ['.agents/skills', '.agent/skills'],
  projectMcpConfigRelpath: () => '.agents/mcp_config.json',
  projectHookConfigRelpath: () => undefined,

  globalRulesFiles: () => [],
  projectRulesPatterns: () => ['.agents/rules/*.md', '.agent/rules/*.md'],
  projectSettingsPatterns: () => ['.agents/mcp_config.json'],

  mcpConfigPathFor(scope: ConfigScope) {
    if (scope.kind === 'global') return this.mcpConfigPath();
    const rel = this.projectMcpConfigRelpath();
    return rel ? join(scope.path, rel) : undefined;
  },
  hookConfigPathFor(_scope: ConfigScope) {
    return undefined; // no hooks
  },
  skillDirFor(scope: ConfigScope) {
    if (scope.kind === 'global') return this.skillDirs()[0];
    const rel = this.projectSkillDirs()[0];
    return rel ? join(scope.path, rel) : undefined;
  },
};
