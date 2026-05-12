/**
 * Codex adapter — OpenAI's Codex CLI agent.
 *
 *   - MCP config:    ~/.codex/config.toml (TOML, [mcp_servers.<name>] sections)
 *   - Skills:        ~/.codex/skills/ (and ~/.agents/skills/ as fallback)
 *   - Project doc:   AGENTS.md / TEAM_GUIDE.md / .agents.md (Codex's default
 *                     fallback list; users may override via project_doc_fallback_filenames)
 *
 * Note: Codex MCP server names must match `[a-zA-Z0-9_-]+` for TOML bare-key
 * compatibility. `deploy.ts::sanitizeMcpName` handles this on write.
 *
 * TODO: readMcpServers requires a TOML parser. Returning [] for now — Valis
 * doesn't need to READ Codex's MCP yet, only WRITE on install. When read is
 * added, evaluate `@iarna/toml` or `smol-toml` (smol-toml is lighter).
 *
 * Adapted from HarnessKit's `hk-core/src/adapter/codex.rs` (Apache-2.0).
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
import { pathExists } from './_util.js';

const HOME = homedir();
const BASE_DIR = join(HOME, '.codex');

export const codexAdapter: HarnessAdapter = {
  name: 'codex' as HarnessName,
  baseDir: () => BASE_DIR,
  detect: async () => pathExists(BASE_DIR),
  skillDirs: () => [join(BASE_DIR, 'skills'), join(HOME, '.agents', 'skills')],
  mcpConfigPath: () => join(BASE_DIR, 'config.toml'),
  hookConfigPath: () => join(BASE_DIR, 'config.toml'), // hooks live in same TOML
  pluginDirs: () => [join(BASE_DIR, 'plugins')],
  hookFormat: (): HookFormat => 'ClaudeLike',
  mcpFormat: (): McpFormat => 'Toml',
  needsPathInjection: () => false,

  async readMcpServers(): Promise<McpServerEntry[]> {
    // TODO: TOML parser dependency. See file header.
    return [];
  },
  async readHooks(): Promise<HookEntry[]> {
    // TODO: TOML parser dependency.
    return [];
  },

  projectMarkers: (): ProjectMarker[] => [
    projectMarkerDir('.codex'),
    projectMarkerFile('AGENTS.md'),
  ],
  projectSkillDirs: () => ['.agents/skills', '.codex/skills'],
  projectMcpConfigRelpath: () => undefined, // Codex has no per-project MCP override; uses global config.toml
  projectHookConfigRelpath: () => undefined,

  globalRulesFiles: () => [join(BASE_DIR, 'AGENTS.md')],
  projectRulesPatterns: () => ['AGENTS.md', 'AGENTS.override.md', 'TEAM_GUIDE.md', '.agents.md'],
  projectSettingsPatterns: () => ['.codex/config.toml'],

  mcpConfigPathFor(scope: ConfigScope) {
    return scope.kind === 'global' ? this.mcpConfigPath() : undefined;
  },
  hookConfigPathFor(scope: ConfigScope) {
    return scope.kind === 'global' ? this.hookConfigPath() : undefined;
  },
  skillDirFor(scope: ConfigScope) {
    if (scope.kind === 'global') return this.skillDirs()[0];
    const rel = this.projectSkillDirs()[0];
    return rel ? join(scope.path, rel) : undefined;
  },
};
