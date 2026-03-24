import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Mock homedir and trackFile before importing modules under test
const fakeHome = join(tmpdir(), `teamind-cursor-test-${Date.now()}`);
vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os');
  return { ...actual, homedir: () => fakeHome };
});
vi.mock('../../src/config/manifest.js', () => ({
  trackFile: vi.fn(),
}));

import { configureCursorMCP, injectCursorrules } from '../../src/ide/cursor.js';
import { detectIDEs } from '../../src/ide/detect.js';
import { trackFile } from '../../src/config/manifest.js';

describe('Cursor IDE integration', () => {
  let projectDir: string;

  beforeEach(async () => {
    projectDir = join(fakeHome, 'project');
    await mkdir(join(fakeHome, '.cursor'), { recursive: true });
    await mkdir(projectDir, { recursive: true });
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await rm(fakeHome, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Detection (T017)
  // -------------------------------------------------------------------------

  describe('detectIDEs — Cursor detection', () => {
    it('detects Cursor when ~/.cursor/ exists', async () => {
      const ides = await detectIDEs();
      const cursor = ides.find((i) => i.name === 'cursor');
      expect(cursor).toBeDefined();
      expect(cursor!.detected).toBe(true);
      expect(cursor!.configPath).toContain('mcp.json');
    });

    it('does not detect Cursor when ~/.cursor/ is absent', async () => {
      await rm(join(fakeHome, '.cursor'), { recursive: true, force: true });
      const ides = await detectIDEs();
      const cursor = ides.find((i) => i.name === 'cursor');
      expect(cursor).toBeDefined();
      expect(cursor!.detected).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // MCP config (T016)
  // -------------------------------------------------------------------------

  describe('configureCursorMCP', () => {
    it('creates mcp.json with teamind server entry', async () => {
      await configureCursorMCP();

      const configPath = join(fakeHome, '.cursor', 'mcp.json');
      const data = JSON.parse(await readFile(configPath, 'utf-8'));
      expect(data.mcpServers.teamind).toEqual({
        command: 'teamind',
        args: ['serve'],
      });
    });

    it('preserves existing servers when adding teamind', async () => {
      const configPath = join(fakeHome, '.cursor', 'mcp.json');
      await writeFile(configPath, JSON.stringify({
        mcpServers: { other: { command: 'other', args: [] } },
      }));

      await configureCursorMCP();

      const data = JSON.parse(await readFile(configPath, 'utf-8'));
      expect(data.mcpServers.other).toBeDefined();
      expect(data.mcpServers.teamind).toBeDefined();
    });

    it('is idempotent — no duplicate entries on re-run', async () => {
      await configureCursorMCP();
      await configureCursorMCP();

      const configPath = join(fakeHome, '.cursor', 'mcp.json');
      const data = JSON.parse(await readFile(configPath, 'utf-8'));
      const serverKeys = Object.keys(data.mcpServers);
      const teamindCount = serverKeys.filter((k) => k === 'teamind').length;
      expect(teamindCount).toBe(1);
    });

    it('tracks the mcp config file in manifest', async () => {
      await configureCursorMCP();
      expect(trackFile).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'mcp_config', ide: 'cursor' }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // .cursorrules injection (T016)
  // -------------------------------------------------------------------------

  describe('injectCursorrules', () => {
    it('creates .cursorrules with teamind markers when file absent', async () => {
      await injectCursorrules(projectDir);

      const content = await readFile(join(projectDir, '.cursorrules'), 'utf-8');
      expect(content).toContain('<!-- teamind:start -->');
      expect(content).toContain('<!-- teamind:end -->');
      expect(content).toContain('teamind_search');
      expect(content).toContain('teamind_store');
      expect(content).toContain('teamind_context');
    });

    it('appends markers to existing .cursorrules', async () => {
      const existing = '# My Project Rules\nAlways use strict mode.\n';
      await writeFile(join(projectDir, '.cursorrules'), existing);

      await injectCursorrules(projectDir);

      const content = await readFile(join(projectDir, '.cursorrules'), 'utf-8');
      expect(content).toContain('# My Project Rules');
      expect(content).toContain('<!-- teamind:start -->');
    });

    it('is idempotent — replaces existing markers without duplication', async () => {
      await injectCursorrules(projectDir);
      await injectCursorrules(projectDir);

      const content = await readFile(join(projectDir, '.cursorrules'), 'utf-8');
      const starts = content.match(/<!-- teamind:start -->/g);
      expect(starts).toHaveLength(1);
    });

    it('tracks the cursorrules file in manifest', async () => {
      await injectCursorrules(projectDir);
      expect(trackFile).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'cursorrules_marker' }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // Cleanup on uninstall (T019)
  // -------------------------------------------------------------------------

  describe('uninstall cleanup', () => {
    it('markers can be cleanly removed from .cursorrules', async () => {
      // Setup: inject markers
      const existing = '# My Rules\n\nSome content here.\n';
      await writeFile(join(projectDir, '.cursorrules'), existing);
      await injectCursorrules(projectDir);

      // Verify markers present
      let content = await readFile(join(projectDir, '.cursorrules'), 'utf-8');
      expect(content).toContain('<!-- teamind:start -->');

      // Simulate uninstall: remove markers (same logic as uninstall.ts)
      const startMarker = '<!-- teamind:start -->';
      const endMarker = '<!-- teamind:end -->';
      const regex = new RegExp(
        `\\n?${escapeRegex(startMarker)}[\\s\\S]*?${escapeRegex(endMarker)}\\n?`,
      );
      const cleaned = content.replace(regex, '\n');
      await writeFile(join(projectDir, '.cursorrules'), cleaned.trim() + '\n');

      // Verify markers removed
      content = await readFile(join(projectDir, '.cursorrules'), 'utf-8');
      expect(content).not.toContain('<!-- teamind:start -->');
      expect(content).toContain('# My Rules');
    });

    it('MCP config can be surgically removed', async () => {
      // Setup
      await configureCursorMCP();
      const configPath = join(fakeHome, '.cursor', 'mcp.json');

      // Verify teamind present
      let data = JSON.parse(await readFile(configPath, 'utf-8'));
      expect(data.mcpServers.teamind).toBeDefined();

      // Simulate uninstall: remove teamind entry (same logic as uninstall.ts)
      delete data.mcpServers.teamind;
      await writeFile(configPath, JSON.stringify(data, null, 2));

      // Verify removed
      data = JSON.parse(await readFile(configPath, 'utf-8'));
      expect(data.mcpServers.teamind).toBeUndefined();
    });
  });
});

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
