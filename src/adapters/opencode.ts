/**
 * OpenCode adapter.
 *
 *   - Base dir:    ~/.config/opencode (XDG-style)
 *   - Config:      opencode.jsonc OR opencode.json in base dir (jsonc preferred when present)
 *   - MCP entry:   top-level "mcp" with tagged-union entries:
 *                  `{ type: "local", command: [bin, ...args], environment: {...} }`
 *   - Hooks:       not supported (use plugins instead) → `hookFormat: 'None'`
 *   - Plugins:     JS/TS files in opencode plugin dirs
 *
 * OpenCode's parser uses `jsonc-parser`, so a single `//` comment in
 * opencode.json silently empties strict-JSON readers. `parseJsonc` in
 * `_util.ts` strips comments lazily.
 *
 * Adapted from HarnessKit's `hk-core/src/adapter/opencode.rs` (Apache-2.0).
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
import { projectMarkerFile } from './types.js';
import type { HarnessAdapter } from './index.js';
import type { HarnessName } from './hook-events.js';
import { pathExists, parseJsonc } from './_util.js';

const HOME = homedir();
const BASE_DIR = join(HOME, '.config', 'opencode');

interface RawOpencodeMcpEntry {
  type?: unknown;
  command?: unknown;
  environment?: Record<string, unknown>;
  enabled?: unknown;
}

interface RawOpencodeConfig {
  mcp?: Record<string, RawOpencodeMcpEntry>;
}

async function pickConfigPath(dir: string): Promise<string> {
  // Prefer .jsonc when it exists; otherwise .json. Same precedence at
  // global and project scope per OpenCode's loader.
  const jsonc = join(dir, 'opencode.jsonc');
  if (await pathExists(jsonc)) return jsonc;
  return join(dir, 'opencode.json');
}

export const opencodeAdapter: HarnessAdapter = {
  name: 'opencode' as HarnessName,
  baseDir: () => BASE_DIR,
  detect: async () => pathExists(BASE_DIR),
  skillDirs: () => [join(BASE_DIR, 'skills'), join(HOME, '.agents', 'skills')],
  mcpConfigPath: () => join(BASE_DIR, 'opencode.json'), // path used when no .jsonc — fast default
  hookConfigPath: () => join(BASE_DIR, 'opencode.json'),
  pluginDirs: () => [join(BASE_DIR, 'plugins')],
  hookFormat: (): HookFormat => 'None', // OpenCode has no hook system
  mcpFormat: (): McpFormat => 'Opencode',
  needsPathInjection: () => false,

  async readMcpServers(): Promise<McpServerEntry[]> {
    const path = await pickConfigPath(BASE_DIR);
    const raw = await parseJsonc<RawOpencodeConfig>(path);
    const mcp = raw?.mcp;
    if (!mcp) return [];
    const out: McpServerEntry[] = [];
    for (const [name, val] of Object.entries(mcp)) {
      // Only local entries map to McpServerEntry; remote entries have a
      // different shape and need separate handling.
      if (val?.type !== 'local') continue;
      if (!Array.isArray(val?.command)) continue;
      const [command, ...args] = val.command.filter(
        (x): x is string => typeof x === 'string',
      );
      if (!command) continue;
      out.push({
        name,
        command,
        args,
        env:
          val.environment && typeof val.environment === 'object'
            ? Object.fromEntries(
                Object.entries(val.environment).filter(
                  (e): e is [string, string] => typeof e[1] === 'string',
                ),
              )
            : {},
        // OpenCode is the ONE harness with a per-entry `enabled` boolean.
        enabled: val.enabled !== false,
      });
    }
    return out;
  },

  async readHooks(): Promise<HookEntry[]> {
    return []; // no hook system
  },

  projectMarkers: (): ProjectMarker[] => [
    projectMarkerFile('opencode.json'),
    projectMarkerFile('opencode.jsonc'),
    projectMarkerFile('AGENTS.md'),
  ],
  projectSkillDirs: () => ['.opencode/skills'],
  projectMcpConfigRelpath: () => 'opencode.json',
  projectHookConfigRelpath: () => undefined,

  globalRulesFiles: () => [join(BASE_DIR, 'AGENTS.md')],
  projectRulesPatterns: () => ['AGENTS.md'],
  projectSettingsPatterns: () => ['opencode.json', 'opencode.jsonc'],

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
