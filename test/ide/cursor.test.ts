/**
 * Cursor IDE integration — `.cursorrules` marker injection.
 *
 * Scope: this file owns the marker injection contract (idempotent
 * write, append vs. create, manifest tracking). MCP-server install and
 * detection are now generic across all 8 harnesses and live in
 * `test/adapters/deploy.test.ts` + the cursor adapter itself, so the
 * legacy `configureCursorMCP` / `detectIDEs` tests have been removed —
 * the surface they covered is gone.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const fakeHome = join(tmpdir(), `valis-cursor-test-${Date.now()}`);
vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os');
  return { ...actual, homedir: () => fakeHome };
});
vi.mock('../../src/config/manifest.js', () => ({
  trackFile: vi.fn(),
}));

import { injectCursorrules } from '../../src/ide/cursor.js';
import { trackFile } from '../../src/config/manifest.js';

describe('Cursor IDE — .cursorrules injection', () => {
  let projectDir: string;

  beforeEach(async () => {
    projectDir = join(fakeHome, 'project');
    await mkdir(projectDir, { recursive: true });
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await rm(fakeHome, { recursive: true, force: true });
  });

  it('creates .cursorrules with valis markers when file absent', async () => {
    await injectCursorrules(projectDir);

    const content = await readFile(join(projectDir, '.cursorrules'), 'utf-8');
    expect(content).toContain('<!-- valis:start -->');
    expect(content).toContain('<!-- valis:end -->');
    expect(content).toContain('valis_search');
    expect(content).toContain('valis_store');
    expect(content).toContain('valis_context');
  });

  it('appends markers to existing .cursorrules', async () => {
    const existing = '# My Project Rules\nAlways use strict mode.\n';
    await writeFile(join(projectDir, '.cursorrules'), existing);

    await injectCursorrules(projectDir);

    const content = await readFile(join(projectDir, '.cursorrules'), 'utf-8');
    expect(content).toContain('# My Project Rules');
    expect(content).toContain('<!-- valis:start -->');
  });

  it('is idempotent — replaces existing markers without duplication', async () => {
    await injectCursorrules(projectDir);
    await injectCursorrules(projectDir);

    const content = await readFile(join(projectDir, '.cursorrules'), 'utf-8');
    const starts = content.match(/<!-- valis:start -->/g);
    expect(starts).toHaveLength(1);
  });

  it('tracks the cursorrules file in manifest', async () => {
    await injectCursorrules(projectDir);
    expect(trackFile).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'cursorrules_marker' }),
    );
  });

  it('markers can be cleanly removed from .cursorrules (uninstall scenario)', async () => {
    const existing = '# My Rules\n\nSome content here.\n';
    await writeFile(join(projectDir, '.cursorrules'), existing);
    await injectCursorrules(projectDir);

    let content = await readFile(join(projectDir, '.cursorrules'), 'utf-8');
    expect(content).toContain('<!-- valis:start -->');

    // Mirror uninstall.ts logic — marker block is fully self-contained.
    const startMarker = '<!-- valis:start -->';
    const endMarker = '<!-- valis:end -->';
    const regex = new RegExp(
      `\\n?${escapeRegex(startMarker)}[\\s\\S]*?${escapeRegex(endMarker)}\\n?`,
    );
    const cleaned = content.replace(regex, '\n');
    await writeFile(join(projectDir, '.cursorrules'), cleaned.trim() + '\n');

    content = await readFile(join(projectDir, '.cursorrules'), 'utf-8');
    expect(content).not.toContain('<!-- valis:start -->');
    expect(content).toContain('# My Rules');
  });
});

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
