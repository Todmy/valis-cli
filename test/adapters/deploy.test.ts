/**
 * Tests for the generic cross-harness deployer primitives.
 *
 * Focus on the invariants HarnessKit's deployer.rs was hardened around:
 *   - sanitization (Codex TOML bare-key constraint)
 *   - resolution + PATH injection (GUI-agent gotcha)
 *   - format dispatch (JSON / Servers / Opencode / TOML)
 *   - idempotent re-deploy (no duplicate entries)
 *   - removeMcpServer round-trip
 *
 * `deploySkill` symlink/TOCTOU tests live separately because they need
 * real filesystem fixtures with symlinks.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  sanitizeMcpName,
  injectPathEnv,
  writeMcpServer,
  removeMcpServer,
} from '../../src/adapters/deploy.js';
import type { HarnessAdapter } from '../../src/adapters/index.js';
import type { ConfigScope, McpServerEntry } from '../../src/adapters/types.js';

// ---------------------------------------------------------------------------
// Tiny test adapter helpers — synthesize an adapter pointing at a temp dir.
// ---------------------------------------------------------------------------

function fakeAdapter(opts: {
  mcpPath: string;
  format: 'McpServers' | 'Servers' | 'Toml' | 'Opencode';
  needsPathInjection?: boolean;
}): HarnessAdapter {
  return {
    name: 'claude-code',
    baseDir: () => '/dev/null',
    detect: async () => true,
    skillDirs: () => [],
    mcpConfigPath: () => opts.mcpPath,
    hookConfigPath: () => opts.mcpPath,
    pluginDirs: () => [],
    hookFormat: () => 'None',
    mcpFormat: () => opts.format,
    needsPathInjection: () => opts.needsPathInjection ?? false,
    async readMcpServers() { return []; },
    async readHooks() { return []; },
    projectMarkers: () => [],
    projectSkillDirs: () => [],
    projectMcpConfigRelpath: () => undefined,
    projectHookConfigRelpath: () => undefined,
    globalRulesFiles: () => [],
    projectRulesPatterns: () => [],
    projectSettingsPatterns: () => [],
    mcpConfigPathFor: (scope) => (scope.kind === 'global' ? opts.mcpPath : undefined),
    hookConfigPathFor: () => undefined,
    skillDirFor: () => undefined,
  };
}

const GLOBAL: ConfigScope = { kind: 'global' };

const SAMPLE: McpServerEntry = {
  name: 'valis',
  command: '/usr/bin/npx',
  args: ['-y', '@valis/mcp'],
  env: { VALIS_API_KEY: 'tm_abc123' },
  enabled: true,
};

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'valis-deploy-'));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Sanitization
// ---------------------------------------------------------------------------

describe('sanitizeMcpName', () => {
  it('passes through TOML-bare-key characters unchanged', () => {
    expect(sanitizeMcpName('valis')).toBe('valis');
    expect(sanitizeMcpName('valis-mcp_v2')).toBe('valis-mcp_v2');
  });

  it('replaces slashes with dashes (Codex constraint)', () => {
    expect(sanitizeMcpName('microsoft/markitdown')).toBe('microsoft-markitdown');
  });

  it('replaces all non-[a-zA-Z0-9_-] with dashes', () => {
    expect(sanitizeMcpName('foo.bar@baz')).toBe('foo-bar-baz');
  });
});

// ---------------------------------------------------------------------------
// PATH injection
// ---------------------------------------------------------------------------

describe('injectPathEnv', () => {
  it('prepends resolved command dir to existing PATH', () => {
    const env = injectPathEnv({ PATH: '/usr/bin' }, '/Users/me/.local/bin/npx');
    expect(env.PATH).toBe('/Users/me/.local/bin:/usr/bin');
  });

  it('creates PATH when env had no PATH', () => {
    const env = injectPathEnv({}, '/Users/me/.local/bin/npx');
    expect(env.PATH).toBe('/Users/me/.local/bin');
  });

  it('does nothing when command is not absolute', () => {
    const env = injectPathEnv({ PATH: '/usr/bin' }, 'npx');
    expect(env).toEqual({ PATH: '/usr/bin' });
  });

  it('preserves other env vars', () => {
    const env = injectPathEnv({ PATH: '/usr/bin', FOO: 'bar' }, '/a/b/c');
    expect(env.FOO).toBe('bar');
  });
});

// ---------------------------------------------------------------------------
// writeMcpServer — JSON formats
// ---------------------------------------------------------------------------

describe('writeMcpServer — McpServers format (Claude, Cursor, Gemini, Windsurf, Antigravity)', () => {
  it('writes a fresh config file with mcpServers top-level key', async () => {
    const path = join(tmp, 'mcp.json');
    const adapter = fakeAdapter({ mcpPath: path, format: 'McpServers' });
    await writeMcpServer(adapter, GLOBAL, SAMPLE);

    const doc = JSON.parse(await fs.readFile(path, 'utf-8'));
    expect(doc.mcpServers.valis).toEqual({
      command: '/usr/bin/npx',
      args: ['-y', '@valis/mcp'],
      env: { VALIS_API_KEY: 'tm_abc123' },
    });
  });

  it('preserves existing entries when adding a new one', async () => {
    const path = join(tmp, 'mcp.json');
    await fs.writeFile(
      path,
      JSON.stringify({ mcpServers: { other: { command: 'foo' } } }),
    );
    const adapter = fakeAdapter({ mcpPath: path, format: 'McpServers' });
    await writeMcpServer(adapter, GLOBAL, SAMPLE);

    const doc = JSON.parse(await fs.readFile(path, 'utf-8'));
    expect(doc.mcpServers.other.command).toBe('foo');
    expect(doc.mcpServers.valis).toBeDefined();
  });

  it('replaces (not duplicates) on re-deploy with same name', async () => {
    const path = join(tmp, 'mcp.json');
    const adapter = fakeAdapter({ mcpPath: path, format: 'McpServers' });
    await writeMcpServer(adapter, GLOBAL, SAMPLE);
    await writeMcpServer(adapter, GLOBAL, { ...SAMPLE, command: '/usr/bin/uvx' });

    const doc = JSON.parse(await fs.readFile(path, 'utf-8'));
    expect(Object.keys(doc.mcpServers)).toEqual(['valis']);
    expect(doc.mcpServers.valis.command).toBe('/usr/bin/uvx');
  });
});

describe('writeMcpServer — Servers format (Copilot / VS Code)', () => {
  it('uses servers top-level key, not mcpServers', async () => {
    const path = join(tmp, 'mcp.json');
    const adapter = fakeAdapter({ mcpPath: path, format: 'Servers' });
    await writeMcpServer(adapter, GLOBAL, SAMPLE);

    const doc = JSON.parse(await fs.readFile(path, 'utf-8'));
    expect(doc.servers.valis).toBeDefined();
    expect(doc.mcpServers).toBeUndefined();
  });
});

describe('writeMcpServer — Opencode format', () => {
  it('writes tagged-union local entry under mcp top-level key', async () => {
    const path = join(tmp, 'opencode.json');
    const adapter = fakeAdapter({ mcpPath: path, format: 'Opencode' });
    await writeMcpServer(adapter, GLOBAL, SAMPLE);

    const doc = JSON.parse(await fs.readFile(path, 'utf-8'));
    expect(doc.mcp.valis).toEqual({
      type: 'local',
      command: ['/usr/bin/npx', '-y', '@valis/mcp'],
      environment: { VALIS_API_KEY: 'tm_abc123' },
    });
  });

  it('includes enabled: false when entry is disabled', async () => {
    const path = join(tmp, 'opencode.json');
    const adapter = fakeAdapter({ mcpPath: path, format: 'Opencode' });
    await writeMcpServer(adapter, GLOBAL, { ...SAMPLE, enabled: false });

    const doc = JSON.parse(await fs.readFile(path, 'utf-8'));
    expect(doc.mcp.valis.enabled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// writeMcpServer — TOML format
// ---------------------------------------------------------------------------

describe('writeMcpServer — TOML format (Codex)', () => {
  it('emits marker-bracketed TOML block', async () => {
    const path = join(tmp, 'config.toml');
    const adapter = fakeAdapter({ mcpPath: path, format: 'Toml' });
    await writeMcpServer(adapter, GLOBAL, SAMPLE);

    const text = await fs.readFile(path, 'utf-8');
    expect(text).toContain('# valis-managed: valis START');
    expect(text).toContain('[mcp_servers.valis]');
    expect(text).toContain('command = "/usr/bin/npx"');
    expect(text).toContain('args = ["-y", "@valis/mcp"]');
    expect(text).toContain('[mcp_servers.valis.env]');
    expect(text).toContain('VALIS_API_KEY = "tm_abc123"');
    expect(text).toContain('# valis-managed: valis END');
  });

  it('is idempotent on re-deploy (no duplicate blocks)', async () => {
    const path = join(tmp, 'config.toml');
    const adapter = fakeAdapter({ mcpPath: path, format: 'Toml' });
    await writeMcpServer(adapter, GLOBAL, SAMPLE);
    await writeMcpServer(adapter, GLOBAL, { ...SAMPLE, command: '/usr/bin/uvx' });

    const text = await fs.readFile(path, 'utf-8');
    const startCount = (text.match(/# valis-managed: valis START/g) ?? []).length;
    expect(startCount).toBe(1);
    expect(text).toContain('command = "/usr/bin/uvx"');
    expect(text).not.toContain('command = "/usr/bin/npx"');
  });

  it('preserves user content outside the marker block', async () => {
    const path = join(tmp, 'config.toml');
    await fs.writeFile(path, '# user comment\n[other_section]\nkey = "value"\n');
    const adapter = fakeAdapter({ mcpPath: path, format: 'Toml' });
    await writeMcpServer(adapter, GLOBAL, SAMPLE);

    const text = await fs.readFile(path, 'utf-8');
    expect(text).toContain('# user comment');
    expect(text).toContain('[other_section]');
    expect(text).toContain('# valis-managed: valis START');
  });

  it('sanitizes name with slash in TOML section header', async () => {
    const path = join(tmp, 'config.toml');
    const adapter = fakeAdapter({ mcpPath: path, format: 'Toml' });
    await writeMcpServer(adapter, GLOBAL, { ...SAMPLE, name: 'microsoft/markitdown' });

    const text = await fs.readFile(path, 'utf-8');
    expect(text).toContain('[mcp_servers.microsoft-markitdown]');
    expect(text).not.toContain('[mcp_servers.microsoft/markitdown]');
  });
});

// ---------------------------------------------------------------------------
// removeMcpServer
// ---------------------------------------------------------------------------

describe('removeMcpServer', () => {
  it('returns true and removes when entry exists (McpServers format)', async () => {
    const path = join(tmp, 'mcp.json');
    const adapter = fakeAdapter({ mcpPath: path, format: 'McpServers' });
    await writeMcpServer(adapter, GLOBAL, SAMPLE);

    const removed = await removeMcpServer(adapter, GLOBAL, 'valis');
    expect(removed).toBe(true);

    const doc = JSON.parse(await fs.readFile(path, 'utf-8'));
    expect(doc.mcpServers.valis).toBeUndefined();
  });

  it('returns false when entry not found', async () => {
    const path = join(tmp, 'mcp.json');
    await fs.writeFile(path, JSON.stringify({ mcpServers: {} }));
    const adapter = fakeAdapter({ mcpPath: path, format: 'McpServers' });

    const removed = await removeMcpServer(adapter, GLOBAL, 'nonexistent');
    expect(removed).toBe(false);
  });

  it('removes TOML marker block', async () => {
    const path = join(tmp, 'config.toml');
    const adapter = fakeAdapter({ mcpPath: path, format: 'Toml' });
    await writeMcpServer(adapter, GLOBAL, SAMPLE);

    const removed = await removeMcpServer(adapter, GLOBAL, 'valis');
    expect(removed).toBe(true);

    const text = await fs.readFile(path, 'utf-8');
    expect(text).not.toContain('valis-managed: valis');
  });
});

// ---------------------------------------------------------------------------
// PATH injection at write time
// ---------------------------------------------------------------------------

describe('writeMcpServer — PATH injection for GUI agents', () => {
  it('does NOT inject PATH for CLI adapters', async () => {
    const path = join(tmp, 'mcp.json');
    const adapter = fakeAdapter({
      mcpPath: path,
      format: 'McpServers',
      needsPathInjection: false,
    });
    await writeMcpServer(adapter, GLOBAL, SAMPLE);

    const doc = JSON.parse(await fs.readFile(path, 'utf-8'));
    expect(doc.mcpServers.valis.env.PATH).toBeUndefined();
  });

  it('injects PATH when adapter declares needsPathInjection', async () => {
    const path = join(tmp, 'mcp.json');
    const adapter = fakeAdapter({
      mcpPath: path,
      format: 'McpServers',
      needsPathInjection: true,
    });
    // Use an absolute command so injection has something to work with.
    await writeMcpServer(adapter, GLOBAL, {
      ...SAMPLE,
      command: '/Users/me/.local/bin/npx',
    });

    const doc = JSON.parse(await fs.readFile(path, 'utf-8'));
    expect(doc.mcpServers.valis.env.PATH).toContain('/Users/me/.local/bin');
  });
});
