/**
 * Claude Code IDE integration — project CLAUDE.md marker injection.
 *
 * The injection content is the AGENT_INSTRUCTIONS block: it tells the agent
 * how to use Valis, declares Valis-first priority, and (since v0.5.4) carries
 * an explicit failure-mode contract so the agent does NOT silently drift to
 * qdrant-find / mem0 / etc. when Valis is unavailable.
 *
 * These tests pin the failure-mode contract into the prompt — accidentally
 * removing it would re-open the silent-data-loss bug fixed in v0.5.4.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const fakeHome = join(tmpdir(), `valis-claudecode-test-${Date.now()}`);
vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os');
  return { ...actual, homedir: () => fakeHome };
});
vi.mock('../../src/config/manifest.js', () => ({
  trackFile: vi.fn(),
}));

import { injectClaudeMdMarkers } from '../../src/ide/claude-code.js';

describe('Claude Code — project CLAUDE.md injection', () => {
  let projectDir: string;

  beforeEach(async () => {
    projectDir = join(fakeHome, 'project');
    await mkdir(projectDir, { recursive: true });
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await rm(fakeHome, { recursive: true, force: true });
  });

  it('writes the Valis instruction block with start/end markers', async () => {
    await injectClaudeMdMarkers(projectDir);
    const content = await readFile(join(projectDir, 'CLAUDE.md'), 'utf-8');
    expect(content).toContain('<!-- valis:start -->');
    expect(content).toContain('<!-- valis:end -->');
    expect(content).toContain('## Team Knowledge (Valis)');
  });

  it('declares Valis-first priority across knowledge-base tools', async () => {
    await injectClaudeMdMarkers(projectDir);
    const content = await readFile(join(projectDir, 'CLAUDE.md'), 'utf-8');
    expect(content).toContain('ALWAYS call valis_search FIRST');
    // Lists alternatives — must cover the major per-user KB tools so the
    // agent recognizes them as substitutes-not-supplements.
    expect(content).toMatch(/qdrant-find/);
    expect(content).toMatch(/mem0/);
  });

  describe('failure-mode contract (BUG: silent drift to other KBs on Valis failure)', () => {
    it('explicitly tells the agent to STOP on Valis failure', async () => {
      await injectClaudeMdMarkers(projectDir);
      const content = await readFile(join(projectDir, 'CLAUDE.md'), 'utf-8');
      expect(content).toContain('Failure-mode contract');
      expect(content).toMatch(/\*\*STOP\.\*\*/);
    });

    it('forbids silent fallback to qdrant / mem0 on Valis failure', async () => {
      await injectClaudeMdMarkers(projectDir);
      const content = await readFile(join(projectDir, 'CLAUDE.md'), 'utf-8');
      expect(content).toMatch(/Do not silently fall back/i);
      expect(content).toMatch(/silent (data )?(loss|drift)/i);
    });

    it('points the user at recovery commands for both OAuth and CLI paths', async () => {
      await injectClaudeMdMarkers(projectDir);
      const content = await readFile(join(projectDir, 'CLAUDE.md'), 'utf-8');
      expect(content).toContain('/mcp');
      expect(content).toContain('valis whoami');
      expect(content).toContain('valis login');
    });

    it('allows explicit user waiver — opt-out is fine, drift is not', async () => {
      await injectClaudeMdMarkers(projectDir);
      const content = await readFile(join(projectDir, 'CLAUDE.md'), 'utf-8');
      expect(content).toMatch(/(waive|waiver|explicitly|opt-out)/i);
    });
  });
});
