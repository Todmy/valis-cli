/**
 * Generic deployer — write operations that consume `HarnessAdapter`
 * declarations and produce on-disk effects in any of the 8 supported
 * harnesses.
 *
 * Three concerns:
 *
 *   1. `deploySkill(source, targetDir)` — TOCTOU-safe directory copy for
 *      SKILL.md bundles. Skips symlinks (lstat check immediately before
 *      copy), skips `.git`.
 *
 *   2. `writeMcpServer / removeMcpServer` — dispatch on adapter's
 *      `mcpFormat()` and write to the right config file (idempotent —
 *      replaces existing entry, doesn't duplicate). Four formats:
 *      McpServers (JSON), Servers (JSON, Copilot), Toml (Codex),
 *      Opencode (JSON, tagged-union local entries).
 *
 *   3. `sanitizeMcpName` + `resolveCommandPath` + `injectPathEnv` —
 *      pre-write transforms. Sanitize matters for Codex's TOML bare-key
 *      rule; resolve+inject matter for GUI agents (Antigravity, Windsurf)
 *      that don't inherit shell `$PATH` when spawning MCP subprocesses.
 *
 * Adapted from HarnessKit's `hk-core/src/deployer.rs` (Apache-2.0).
 *
 * Out of scope (TODO):
 *   - Hook write (per-format hook serialization). Valis's adoption story
 *     today is "register the MCP server"; hooks are Claude-Code-specific
 *     deepening. Add when a second harness needs Valis hooks.
 *   - Plugin write (formal plugin systems). Same reasoning.
 *   - Codex TOML *read* (depends on TOML parser). Write path here emits
 *     TOML directly without parsing existing — uses a marker-block
 *     pattern that's idempotent on re-run.
 */

import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { McpServerEntry, ConfigScope } from './types.js';
import type { HarnessAdapter } from './index.js';

const execFileP = promisify(execFile);

// ---------------------------------------------------------------------------
// Pre-write transforms
// ---------------------------------------------------------------------------

/**
 * Sanitize an MCP server name to `[a-zA-Z0-9_-]+`.
 *
 * Required for Codex (TOML bare keys) and best practice everywhere.
 * `microsoft/markitdown` → `microsoft-markitdown`.
 */
export function sanitizeMcpName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '-');
}

/**
 * Resolve a bare command name to an absolute path via `which` (Unix) or
 * `where` (Windows). Returns the original input when resolution fails or
 * the input is already absolute.
 *
 * Why we need this: GUI-launched agents (Antigravity, Windsurf) spawn MCP
 * server subprocesses without sourcing the user's shell rc files, so
 * `command: "npx"` fails with ENOENT. Pre-resolving to
 * `/Users/me/.local/bin/npx` at deploy time sidesteps that.
 */
export async function resolveCommandPath(command: string): Promise<string> {
  if (command.startsWith('/') || /^[A-Za-z]:[\\/]/.test(command)) {
    return command; // already absolute (Unix or Windows)
  }
  try {
    const isWindows = process.platform === 'win32';
    const tool = isWindows ? 'where' : 'which';
    const { stdout } = await execFileP(tool, [command]);
    const first = stdout.split(/\r?\n/).find((line) => line.trim().length > 0);
    return first?.trim() ?? command;
  } catch {
    return command;
  }
}

/**
 * Build an env block that augments `$PATH` with the directory of the
 * resolved command. Used when `adapter.needsPathInjection()` is true.
 * Pure — doesn't read `process.env`, only adds an entry to the caller's
 * env map.
 */
export function injectPathEnv(
  env: Record<string, string>,
  resolvedCommand: string,
): Record<string, string> {
  if (!resolvedCommand.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(resolvedCommand)) {
    return env; // unresolved; nothing to inject
  }
  const dir = dirname(resolvedCommand);
  const existingPath = env.PATH ?? '';
  const sep = process.platform === 'win32' ? ';' : ':';
  // Prepend so the resolved tool wins over user shell PATH
  const newPath = existingPath ? `${dir}${sep}${existingPath}` : dir;
  return { ...env, PATH: newPath };
}

// ---------------------------------------------------------------------------
// Skill deployment (TOCTOU-safe copy)
// ---------------------------------------------------------------------------

/**
 * Copy a skill (file or directory) into a harness's skill directory.
 * Symlinks are skipped (lstat-checked at copy time, not readdir time).
 * `.git` directories are skipped. Returns the deployed entry's name.
 */
export async function deploySkill(sourcePath: string, targetSkillDir: string): Promise<string> {
  await fs.mkdir(targetSkillDir, { recursive: true });
  const stat = await fs.lstat(sourcePath);

  if (stat.isDirectory()) {
    const name = baseName(sourcePath);
    const dest = join(targetSkillDir, name);
    await copyDirRecursive(sourcePath, dest);
    return name;
  } else {
    const name = baseName(sourcePath);
    const dest = join(targetSkillDir, name);
    await fs.copyFile(sourcePath, dest);
    return name;
  }
}

async function copyDirRecursive(src: string, dst: string): Promise<void> {
  await fs.mkdir(dst, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = join(src, entry.name);
    const dstPath = join(dst, entry.name);

    // TOCTOU window: stat just before the operation, not just after readdir.
    let meta;
    try {
      meta = await fs.lstat(srcPath);
    } catch (err) {
      console.warn(`[valis/deploy] cannot read metadata for ${srcPath}: ${(err as Error).message}`);
      continue;
    }
    if (meta.isSymbolicLink()) {
      console.warn(`[valis/deploy] skipping symlink: ${srcPath}`);
      continue;
    }
    if (meta.isDirectory()) {
      if (entry.name === '.git') continue;
      await copyDirRecursive(srcPath, dstPath);
    } else if (meta.isFile()) {
      await fs.copyFile(srcPath, dstPath);
    }
  }
}

function baseName(p: string): string {
  const idx = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return idx === -1 ? p : p.slice(idx + 1);
}

// ---------------------------------------------------------------------------
// MCP server write — format dispatch
// ---------------------------------------------------------------------------

/**
 * Write an MCP server entry to the harness's config file, idempotently
 * (replaces an existing entry with the same name, never duplicates).
 *
 * Handles all 4 formats. Honors `adapter.needsPathInjection()` — when
 * true, the command is resolved and `PATH` is injected into env.
 *
 * Throws if the scope can't be resolved for this adapter (e.g. project
 * scope passed to Codex, which has no per-project MCP config).
 */
export async function writeMcpServer(
  adapter: HarnessAdapter,
  scope: ConfigScope,
  server: McpServerEntry,
): Promise<void> {
  const path = adapter.mcpConfigPathFor(scope);
  if (!path) {
    throw new Error(
      `${adapter.name}: no MCP config path for scope ${scope.kind}`,
    );
  }

  // Pre-write transforms
  let finalServer = { ...server, name: sanitizeMcpName(server.name) };
  if (adapter.needsPathInjection()) {
    const resolved = await resolveCommandPath(finalServer.command);
    finalServer = {
      ...finalServer,
      command: resolved,
      env: injectPathEnv(finalServer.env, resolved),
    };
  }

  await fs.mkdir(dirname(path), { recursive: true });

  switch (adapter.mcpFormat()) {
    case 'McpServers':
      await writeJsonTopLevelKey(path, 'mcpServers', finalServer);
      return;
    case 'Servers':
      await writeJsonTopLevelKey(path, 'servers', finalServer);
      return;
    case 'Opencode':
      await writeOpencodeMcp(path, finalServer);
      return;
    case 'Toml':
      await writeTomlMcp(path, finalServer);
      return;
  }
}

/**
 * Remove an MCP server entry from the harness's config file.
 * Returns true when an entry was removed, false when none was found.
 */
export async function removeMcpServer(
  adapter: HarnessAdapter,
  scope: ConfigScope,
  name: string,
): Promise<boolean> {
  const path = adapter.mcpConfigPathFor(scope);
  if (!path) return false;
  const sanitized = sanitizeMcpName(name);

  switch (adapter.mcpFormat()) {
    case 'McpServers':
      return removeJsonTopLevelKey(path, 'mcpServers', sanitized);
    case 'Servers':
      return removeJsonTopLevelKey(path, 'servers', sanitized);
    case 'Opencode':
      return removeJsonTopLevelKey(path, 'mcp', sanitized);
    case 'Toml':
      return removeTomlMcp(path, sanitized);
  }
}

// ---------------------------------------------------------------------------
// JSON writers (top-level key: mcpServers | servers | mcp)
// ---------------------------------------------------------------------------

async function writeJsonTopLevelKey(
  path: string,
  topKey: 'mcpServers' | 'servers',
  server: McpServerEntry,
): Promise<void> {
  const doc = await readJsonOrEmpty(path);
  const entry: Record<string, unknown> = {
    command: server.command,
    args: server.args,
  };
  if (Object.keys(server.env).length > 0) entry.env = server.env;

  const bucket = (doc[topKey] as Record<string, unknown>) ?? {};
  bucket[server.name] = entry;
  doc[topKey] = bucket;

  await writeJsonAtomic(path, doc);
}

async function writeOpencodeMcp(path: string, server: McpServerEntry): Promise<void> {
  const doc = await readJsonOrEmpty(path);
  const entry: Record<string, unknown> = {
    type: 'local',
    command: [server.command, ...server.args],
  };
  if (Object.keys(server.env).length > 0) entry.environment = server.env;
  if (!server.enabled) entry.enabled = false;

  const bucket = (doc.mcp as Record<string, unknown>) ?? {};
  bucket[server.name] = entry;
  doc.mcp = bucket;

  await writeJsonAtomic(path, doc);
}

async function removeJsonTopLevelKey(
  path: string,
  topKey: string,
  name: string,
): Promise<boolean> {
  const doc = await readJsonOrEmpty(path);
  const bucket = doc[topKey] as Record<string, unknown> | undefined;
  if (!bucket || !(name in bucket)) return false;
  delete bucket[name];
  doc[topKey] = bucket;
  await writeJsonAtomic(path, doc);
  return true;
}

async function readJsonOrEmpty(path: string): Promise<Record<string, unknown>> {
  try {
    const content = await fs.readFile(path, 'utf-8');
    const parsed = JSON.parse(content);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

async function writeJsonAtomic(path: string, doc: Record<string, unknown>): Promise<void> {
  const tmp = `${path}.valis-tmp-${process.pid}`;
  const content = JSON.stringify(doc, null, 2) + '\n';
  await fs.writeFile(tmp, content, 'utf-8');
  await fs.rename(tmp, path);
}

// ---------------------------------------------------------------------------
// TOML writer (Codex) — marker-block idempotent replace
// ---------------------------------------------------------------------------
//
// We don't pull a TOML parser dependency for the WRITE path. Instead we
// use marker-block comments so re-running the deploy is idempotent:
//
//   # valis-managed: <name> START
//   [mcp_servers.<name>]
//   command = "..."
//   args = ["...", "..."]
//   [mcp_servers.<name>.env]
//   FOO = "bar"
//   # valis-managed: <name> END
//
// On re-run, the existing block (start-to-end inclusive) is removed and a
// fresh block is appended. Other content in the TOML file is untouched.
// ---------------------------------------------------------------------------

async function writeTomlMcp(path: string, server: McpServerEntry): Promise<void> {
  const existing = await readFileOrEmpty(path);
  const stripped = stripMarkerBlock(existing, server.name);
  const block = emitTomlMcpBlock(server);
  const sep = stripped.length === 0 || stripped.endsWith('\n') ? '' : '\n';
  await writeFileAtomic(path, stripped + sep + block);
}

async function removeTomlMcp(path: string, name: string): Promise<boolean> {
  const existing = await readFileOrEmpty(path);
  const stripped = stripMarkerBlock(existing, name);
  if (stripped === existing) return false;
  await writeFileAtomic(path, stripped);
  return true;
}

function emitTomlMcpBlock(server: McpServerEntry): string {
  const lines: string[] = [
    `# valis-managed: ${server.name} START`,
    `[mcp_servers.${server.name}]`,
    `command = ${tomlString(server.command)}`,
  ];
  if (server.args.length > 0) {
    lines.push(`args = [${server.args.map(tomlString).join(', ')}]`);
  }
  if (Object.keys(server.env).length > 0) {
    lines.push(`[mcp_servers.${server.name}.env]`);
    for (const [k, v] of Object.entries(server.env)) {
      lines.push(`${tomlBareOrQuoted(k)} = ${tomlString(v)}`);
    }
  }
  lines.push(`# valis-managed: ${server.name} END`);
  return lines.join('\n') + '\n';
}

function stripMarkerBlock(text: string, name: string): string {
  // Escape regex special chars in name (it's already sanitized but be safe).
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(
    `\\n?# valis-managed: ${escaped} START[\\s\\S]*?# valis-managed: ${escaped} END\\n?`,
    'g',
  );
  return text.replace(re, '');
}

function tomlString(s: string): string {
  // Basic-string form: escape backslash, double-quote, and control chars.
  const escaped = s
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
  return `"${escaped}"`;
}

function tomlBareOrQuoted(key: string): string {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : tomlString(key);
}

async function readFileOrEmpty(path: string): Promise<string> {
  try {
    return await fs.readFile(path, 'utf-8');
  } catch {
    return '';
  }
}

async function writeFileAtomic(path: string, content: string): Promise<void> {
  const tmp = `${path}.valis-tmp-${process.pid}`;
  await fs.writeFile(tmp, content, 'utf-8');
  await fs.rename(tmp, path);
}
