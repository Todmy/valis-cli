/**
 * Adapter registry — one module per harness implements `HarnessAdapter`.
 *
 * The interface is intentionally **data-first**: an adapter declares
 * paths, formats, and project markers; generic deployers/readers in
 * `../deploy.ts` (forthcoming) do the actual filesystem work using
 * those declarations. The adapter does NOT own deploy logic — that's a
 * shared concern across harnesses.
 *
 * Compare with `../ide/<name>.ts`, which is **action-based** (each module
 * exports `configureXxxMCP`, `injectXxxMarkers`, ...). The two layers
 * coexist for now:
 *   - `ide/` — production code path used by `valis init`'s `setupIDEs`
 *   - `adapters/` — new data-first layer; migration target. Each
 *     `ide/<harness>.ts` will eventually be replaced by reading the
 *     `HarnessAdapter` declarations and doing generic install.
 *
 * Adapted from HarnessKit's `hk-core/src/adapter/mod.rs::AgentAdapter`
 * trait (Apache-2.0, github.com/RealZST/HarnessKit).
 */

import type {
  ConfigScope,
  HookEntry,
  HookFormat,
  McpFormat,
  McpServerEntry,
  PluginEntry,
  ProjectMarker,
} from './types.js';
import type { HarnessName } from './hook-events.js';

export interface HarnessAdapter {
  /** Stable identifier matching `HarnessName`. */
  readonly name: HarnessName;

  /** Base config dir, e.g. `~/.claude`. */
  baseDir(): string;

  /** True when this harness appears to be installed (base dir exists). */
  detect(): Promise<boolean>;

  // --- File-system roles ---

  /** Global skill directories (absolute paths). */
  skillDirs(): string[];

  /** Path to the global MCP config file. */
  mcpConfigPath(): string;

  /** Path to the global hook config file. Same as plugin config for most agents. */
  hookConfigPath(): string;

  /** Global plugin directories (absolute paths). */
  pluginDirs(): string[];

  /** Path to the file where plugin enable/disable state lives. Defaults to `hookConfigPath()`. */
  pluginConfigPath?(): string;

  // --- Wire formats ---

  /** How this harness serializes hooks. */
  hookFormat(): HookFormat;

  /** How this harness serializes MCP servers. */
  mcpFormat(): McpFormat;

  /**
   * True if this harness needs Valis to resolve bare command names
   * (`npx`, `uvx`) to absolute paths and inject `PATH` into the MCP env
   * block at deploy time. Required for GUI-launched harnesses
   * (Antigravity, Windsurf-from-GUI) that don't inherit shell `$PATH`.
   */
  needsPathInjection(): boolean;

  // --- Readers ---

  /** Parse MCP servers from the global config. */
  readMcpServers(): Promise<McpServerEntry[]>;

  /** Parse MCP servers from a project-scoped config file. */
  readMcpServersFrom?(path: string): Promise<McpServerEntry[]>;

  /** Parse hooks from the global config. */
  readHooks(): Promise<HookEntry[]>;

  /** Parse hooks from a project-scoped config file. */
  readHooksFrom?(path: string): Promise<HookEntry[]>;

  /** Parse plugins (formal plugin systems only — Claude, VS Code, Cursor 2.5+). */
  readPlugins?(): Promise<PluginEntry[]>;

  // --- Project-scope discovery ---

  /**
   * Markers that identify a directory as belonging to this harness.
   * `discoverProjects()` (forthcoming) walks candidate dirs and matches
   * any adapter's markers.
   */
  projectMarkers(): ProjectMarker[];

  /** Relative project paths/globs for skill directories (e.g. `.claude/skills`). */
  projectSkillDirs(): string[];

  /** Relative path of the project-level MCP config file (e.g. `.mcp.json`). */
  projectMcpConfigRelpath(): string | undefined;

  /** Relative path of the project-level hook config file. */
  projectHookConfigRelpath(): string | undefined;

  // --- Markdown / rules discovery (for inspection UIs and AGENTS.md augmentation) ---

  /** Global rule files (absolute paths). */
  globalRulesFiles(): string[];

  /** Relative project paths/globs for rules within a project dir. */
  projectRulesPatterns(): string[];

  /** Relative project paths/globs for settings within a project dir. */
  projectSettingsPatterns(): string[];

  // --- Resolved paths ---

  /** Resolve the MCP config file for a given scope. */
  mcpConfigPathFor(scope: ConfigScope): string | undefined;

  /** Resolve the hook config file for a given scope. */
  hookConfigPathFor(scope: ConfigScope): string | undefined;

  /** Resolve the skill directory for a given scope. */
  skillDirFor(scope: ConfigScope): string | undefined;
}

import { claudeCodeAdapter } from './claude-code.js';

/**
 * All adapters in canonical display order. Future harness additions
 * (codex, cursor, gemini, copilot, windsurf, antigravity, opencode)
 * register here.
 */
export const ALL_ADAPTERS: HarnessAdapter[] = [
  claudeCodeAdapter,
];

export type { HarnessName } from './hook-events.js';
