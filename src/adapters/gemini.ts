/**
 * Gemini CLI adapter.
 *
 *   - MCP config:    ~/.gemini/settings.json (top-level "mcpServers")
 *   - Extensions:    ~/.gemini/extensions/<name>/ with gemini-extension.json
 *   - Enablement:    ~/.gemini/extension-enablement.json (path-based rules)
 *
 * Adapted from HarnessKit's `hk-core/src/adapter/gemini.rs` (Apache-2.0).
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
const BASE_DIR = join(HOME, '.gemini');

interface RawGeminiSettings {
  mcpServers?: Record<
    string,
    { command?: unknown; args?: unknown; env?: Record<string, unknown> }
  >;
}

export const geminiAdapter: HarnessAdapter = {
  name: 'gemini' as HarnessName,
  baseDir: () => BASE_DIR,
  detect: async () => pathExists(BASE_DIR),
  skillDirs: () => [join(BASE_DIR, 'skills'), join(HOME, '.agents', 'skills')],
  mcpConfigPath: () => join(BASE_DIR, 'settings.json'),
  hookConfigPath: () => join(BASE_DIR, 'settings.json'),
  pluginDirs: () => [join(BASE_DIR, 'extensions')],
  hookFormat: (): HookFormat => 'ClaudeLike',
  mcpFormat: (): McpFormat => 'McpServers',
  needsPathInjection: () => false,

  async readMcpServers(): Promise<McpServerEntry[]> {
    const raw = await parseJson<RawGeminiSettings>(this.mcpConfigPath());
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
    // Gemini hooks docs evolved through 2025; format is ClaudeLike per HK
    // metadata but parser TODO until Valis has a use case.
    return [];
  },

  projectMarkers: (): ProjectMarker[] => [projectMarkerDir('.gemini')],
  projectSkillDirs: () => ['.gemini/skills'],
  projectMcpConfigRelpath: () => '.gemini/settings.json',
  projectHookConfigRelpath: () => '.gemini/settings.json',

  globalRulesFiles: () => [join(BASE_DIR, 'GEMINI.md')],
  projectRulesPatterns: () => ['GEMINI.md', '.gemini/GEMINI.md'],
  projectSettingsPatterns: () => ['.gemini/settings.json'],

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
