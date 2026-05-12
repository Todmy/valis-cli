/**
 * Cursor adapter.
 *
 *   - MCP config:    ~/.cursor/mcp.json (global), .cursor/mcp.json (project)
 *   - Hook config:   ~/.cursor/hooks.json
 *   - Plugins:       ~/.cursor/plugins/, manifest at .cursor-plugin/plugin.json
 *   - Skills:        ~/.cursor/skills/ + ~/.agents/skills/; project at .cursor/skills/
 *
 * Adapted from HarnessKit's `hk-core/src/adapter/cursor.rs` (Apache-2.0).
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
import { projectMarkerDir, projectMarkerFile } from './types.js';
import type { HarnessAdapter } from './index.js';
import type { HarnessName } from './hook-events.js';
import { pathExists, parseJson } from './_util.js';

const HOME = homedir();
const BASE_DIR = join(HOME, '.cursor');

interface RawCursorMcp {
  mcpServers?: Record<
    string,
    { command?: unknown; args?: unknown; env?: Record<string, unknown> }
  >;
}

interface RawCursorHooks {
  hooks?: Record<string, Array<{ command?: unknown }>>;
}

export const cursorAdapter: HarnessAdapter = {
  name: 'cursor' as HarnessName,
  baseDir: () => BASE_DIR,
  detect: async () => pathExists(BASE_DIR),
  skillDirs: () => [join(BASE_DIR, 'skills'), join(HOME, '.agents', 'skills')],
  mcpConfigPath: () => join(BASE_DIR, 'mcp.json'),
  hookConfigPath: () => join(BASE_DIR, 'hooks.json'),
  pluginDirs: () => [join(BASE_DIR, 'plugins')],
  hookFormat: (): HookFormat => 'Cursor',
  mcpFormat: (): McpFormat => 'McpServers',
  needsPathInjection: () => false,

  async readMcpServers(): Promise<McpServerEntry[]> {
    return this.readMcpServersFrom!(this.mcpConfigPath());
  },
  async readMcpServersFrom(path: string): Promise<McpServerEntry[]> {
    const raw = await parseJson<RawCursorMcp>(path);
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
                (entry): entry is [string, string] => typeof entry[1] === 'string',
              ),
            )
          : {},
      enabled: true,
    }));
  },

  async readHooks(): Promise<HookEntry[]> {
    return this.readHooksFrom!(this.hookConfigPath());
  },
  async readHooksFrom(path: string): Promise<HookEntry[]> {
    const raw = await parseJson<RawCursorHooks>(path);
    const hooks = raw?.hooks;
    if (!hooks) return [];
    const out: HookEntry[] = [];
    for (const [event, list] of Object.entries(hooks)) {
      if (!Array.isArray(list)) continue;
      for (const entry of list) {
        if (typeof entry?.command === 'string') {
          out.push({ event, command: entry.command });
        }
      }
    }
    return out;
  },

  projectMarkers: (): ProjectMarker[] => [
    projectMarkerDir('.cursor'),
    projectMarkerFile('.cursorrules'),
  ],
  projectSkillDirs: () => ['.cursor/skills'],
  projectMcpConfigRelpath: () => '.cursor/mcp.json',
  projectHookConfigRelpath: () => '.cursor/hooks.json',

  globalRulesFiles: () => [],
  projectRulesPatterns: () => ['.cursorrules', '.cursor/rules/*.md'],
  projectSettingsPatterns: () => ['.cursor/mcp.json', '.cursor/hooks.json'],

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
