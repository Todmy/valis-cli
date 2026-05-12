/**
 * Canonical types shared across all harness adapters.
 *
 * Adapted from HarnessKit's `hk-core/src/adapter/mod.rs` (Apache-2.0,
 * github.com/RealZST/HarnessKit). The pattern: every harness parses its
 * native format INTO these common shapes, and every deployer reads OUT
 * of these common shapes back into the target harness's format. Adapter
 * files own the translation; the rest of Valis works only with these
 * types.
 *
 * Why "canonical intermediate form" instead of "lowest common denominator":
 * we pick the richest harness's vocabulary (Claude Code's) as canonical,
 * and adapters for thinner harnesses map back as best they can. Trying to
 * design a vendor-neutral schema would invent a fourth thing that matches
 * no harness exactly.
 */

/**
 * MCP server entry — canonical shape, the union of fields Claude/Codex/
 * Cursor/Gemini/Copilot/OpenCode actually need. Per-harness `enabled` is
 * orthogonal: only OpenCode's schema has a per-entry boolean; others have
 * no native disable concept and Valis-level disable state lives elsewhere.
 */
export interface McpServerEntry {
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  enabled: boolean;
}

/**
 * Hook entry — `event` is the *agent's* native event name; cross-agent
 * translation goes through `hook-events.ts`. `matcher` is optional and
 * only meaningful for ClaudeLike formats.
 */
export interface HookEntry {
  event: string;
  matcher?: string;
  command: string;
}

/**
 * Plugin entry — for harnesses with formal plugin systems (Claude Code,
 * VS Code, Cursor 2.5+). The `uri` and `installedAt`/`updatedAt` fields
 * are populated when the harness's own state store has them; otherwise
 * Valis falls back to filesystem heuristics.
 */
export interface PluginEntry {
  name: string;
  source: string;
  enabled: boolean;
  path?: string;
  uri?: string;
  installedAt?: Date;
  updatedAt?: Date;
}

/**
 * Hook config wire format per harness. The serializer reads this tag and
 * picks the right shape; readers do the inverse.
 *
 * - `ClaudeLike` — `{ hooks: { Event: [{ matcher, hooks: ["cmd"] }] } }`. Used by Claude, Codex, Gemini.
 * - `Cursor`     — `{ version: 1, hooks: { event: [{ command: "cmd" }] } }`.
 * - `Copilot`    — `{ version: 1, hooks: { event: [{ type: "command", bash: "cmd" }] } }`.
 * - `Windsurf`   — `{ hooks: { event: [{ command: "cmd" }] } }`.
 * - `None`       — agent does not support hooks (Antigravity, OpenCode).
 */
export type HookFormat = 'ClaudeLike' | 'Cursor' | 'Copilot' | 'Windsurf' | 'None';

/**
 * MCP server config wire format per harness.
 *
 * - `McpServers` — JSON, top-level `"mcpServers"` key. Claude, Gemini, Cursor, Antigravity.
 * - `Servers`    — JSON, top-level `"servers"` key. Copilot / VS Code.
 * - `Toml`       — TOML with `[mcp_servers.<name>]` sections. Codex. Names must match `[a-zA-Z0-9_-]+`.
 * - `Opencode`   — JSON top-level `"mcp"` with tagged-union entries `{type:"local", command:[bin,...args]}`.
 */
export type McpFormat = 'McpServers' | 'Servers' | 'Toml' | 'Opencode';

/**
 * On-disk marker that identifies a directory as belonging to a harness.
 * Used by project detection: a directory is a project for a harness when
 * any of that harness's markers exist there.
 */
export type ProjectMarker =
  | { kind: 'dir'; path: string }
  | { kind: 'file'; path: string };

export const projectMarkerDir = (path: string): ProjectMarker => ({ kind: 'dir', path });
export const projectMarkerFile = (path: string): ProjectMarker => ({ kind: 'file', path });

/**
 * Where the config we're reading/writing lives — globally (user-scope) or
 * pinned to a specific project directory. Adapters resolve paths against
 * this scope.
 */
export type ConfigScope =
  | { kind: 'global' }
  | { kind: 'project'; path: string };

export const GLOBAL_SCOPE: ConfigScope = { kind: 'global' };
export const projectScope = (path: string): ConfigScope => ({ kind: 'project', path });
