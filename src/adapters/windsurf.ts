/**
 * Windsurf adapter — Cascade-based agent (formerly Codeium).
 *
 *   - Base dir:    ~/.codeium/windsurf
 *   - MCP config:  ~/.codeium/windsurf/mcp_config.json
 *   - Hooks:       ~/.codeium/windsurf/hooks.json (global), .windsurf/hooks.json (project)
 *   - Workflows:   ~/.codeium/windsurf/global_workflows/*.md
 *   - Ignore:      .codeiumignore in project root
 *
 * GUI-launched → `needsPathInjection: true` so MCP servers spawned from
 * Windsurf inherit a sane PATH (without sourcing the user's shell rc).
 *
 * Adapted from HarnessKit's `hk-core/src/adapter/windsurf.rs` (Apache-2.0).
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
const BASE_DIR = join(HOME, '.codeium', 'windsurf');

interface RawWindsurfMcp {
  mcpServers?: Record<
    string,
    { command?: unknown; args?: unknown; env?: Record<string, unknown> }
  >;
}

interface RawWindsurfHooks {
  hooks?: Record<string, Array<{ command?: unknown }>>;
}

export const windsurfAdapter: HarnessAdapter = {
  name: 'windsurf' as HarnessName,
  baseDir: () => BASE_DIR,
  detect: async () => pathExists(BASE_DIR),
  skillDirs: () => [join(BASE_DIR, 'skills'), join(HOME, '.agents', 'skills')],
  mcpConfigPath: () => join(BASE_DIR, 'mcp_config.json'),
  hookConfigPath: () => join(BASE_DIR, 'hooks.json'),
  pluginDirs: () => [],
  hookFormat: (): HookFormat => 'Windsurf',
  mcpFormat: (): McpFormat => 'McpServers',
  needsPathInjection: () => true, // GUI-launched — see file header

  async readMcpServers(): Promise<McpServerEntry[]> {
    const raw = await parseJson<RawWindsurfMcp>(this.mcpConfigPath());
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
    return this.readHooksFrom!(this.hookConfigPath());
  },
  async readHooksFrom(path: string): Promise<HookEntry[]> {
    const raw = await parseJson<RawWindsurfHooks>(path);
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
    projectMarkerDir('.windsurf'),
    projectMarkerFile('.codeiumignore'),
  ],
  projectSkillDirs: () => ['.windsurf/skills'],
  projectMcpConfigRelpath: () => '.windsurf/mcp_config.json',
  projectHookConfigRelpath: () => '.windsurf/hooks.json',

  globalRulesFiles: () => [join(BASE_DIR, 'memories', 'global_rules.md')],
  projectRulesPatterns: () => ['.windsurf/rules/*.md', '.windsurfrules'],
  projectSettingsPatterns: () => ['.windsurf/mcp_config.json', '.windsurf/hooks.json'],

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
