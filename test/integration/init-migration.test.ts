/**
 * T041 — integration test for the Memory.md migration flow.
 *
 * Exercises the same primitives init.ts orchestrates: detect → preview →
 * accept (backup + stub-replace + manifest) OR decline (suppress 30 days)
 * → re-run is idempotent.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  detectCandidates,
  loadManifest,
  isAlreadyMigrated,
  isDeclineSuppressed,
  recordDecline,
  recordMigration,
  backupAndStub,
  renderPreview,
} from '../../src/hooks/migration.js';

const PROJECT_ID = '11111111-1111-1111-1111-111111111111';

let tempHome: string;
let projectDir: string;
let prevValisHome: string | undefined;

beforeEach(async () => {
  tempHome = await mkdtemp(join(tmpdir(), 'valis-init-mig-home-'));
  projectDir = await mkdtemp(join(tmpdir(), 'valis-init-mig-proj-'));
  prevValisHome = process.env.VALIS_HOME;
  process.env.VALIS_HOME = tempHome;
});

afterEach(async () => {
  if (prevValisHome === undefined) delete process.env.VALIS_HOME;
  else process.env.VALIS_HOME = prevValisHome;
  await rm(tempHome, { recursive: true, force: true });
  await rm(projectDir, { recursive: true, force: true });
});

const FIXTURE = `# Project rules

## Decisions
- Use TTL + own-write cache invalidation
- Prefer Vercel over Netlify

## Patterns
- Always wrap fetch with AbortController

## Constraints
- Never store secrets in git history
`;

describe('init migration — accept flow', () => {
  it('detects candidates → preview → backup → stub-replace → manifest', async () => {
    const memoryPath = join(projectDir, 'MEMORY.md');
    await writeFile(memoryPath, FIXTURE);

    // Detect.
    const candidates = await detectCandidates(projectDir);
    expect(candidates.length).toBe(1);
    expect(candidates[0].entries.length).toBe(4);

    // Preview includes the canonical "Valis detected" string init.ts uses.
    const preview = renderPreview(candidates);
    expect(preview).toContain('Found existing memory file');

    // Accept: backup + manifest.
    const manifest = await loadManifest(PROJECT_ID);
    manifest.project_name = 'valis';
    const backupPath = await backupAndStub(candidates[0], PROJECT_ID);
    await recordMigration(manifest, {
      candidate: candidates[0],
      backupPath,
      decisionIds: [],
      migratedAt: new Date().toISOString(),
    });

    // Backup retains the original verbatim.
    expect(await readFile(backupPath, 'utf-8')).toBe(FIXTURE);
    // Original was replaced by a stub pointer to the backup.
    const replaced = await readFile(memoryPath, 'utf-8');
    expect(replaced).toContain('Memory has moved to Valis');
    expect(replaced).toContain(backupPath);
    // Manifest persists the migration entry.
    const reloaded = await loadManifest(PROJECT_ID);
    expect(reloaded.migrations.length).toBe(1);
    expect(reloaded.migrations[0].entries_migrated).toBe(4);
  });

  it('re-detects nothing after the original has been stub-replaced', async () => {
    await writeFile(join(projectDir, 'MEMORY.md'), FIXTURE);
    const first = await detectCandidates(projectDir);
    const manifest = await loadManifest(PROJECT_ID);
    const backupPath = await backupAndStub(first[0], PROJECT_ID);
    await recordMigration(manifest, {
      candidate: first[0],
      backupPath,
      decisionIds: [],
      migratedAt: new Date().toISOString(),
    });

    // Re-detect: stub pointer has no bullet entries → no candidates.
    const second = await detectCandidates(projectDir);
    expect(second).toEqual([]);
  });

  it('idempotent re-run: same content already migrated → suppressed', async () => {
    await writeFile(join(projectDir, 'MEMORY.md'), FIXTURE);
    const candidates = await detectCandidates(projectDir);
    const manifest = await loadManifest(PROJECT_ID);
    const backupPath = await backupAndStub(candidates[0], PROJECT_ID);
    await recordMigration(manifest, {
      candidate: candidates[0],
      backupPath,
      decisionIds: [],
      migratedAt: new Date().toISOString(),
    });

    // Restore original content (simulating engineer rolling back the stub).
    await writeFile(join(projectDir, 'MEMORY.md'), FIXTURE);
    const reloaded = await loadManifest(PROJECT_ID);
    const re = await detectCandidates(projectDir);
    // The detected candidate hash matches the prior migration.
    expect(re.length).toBe(1);
    expect(isAlreadyMigrated(re[0], reloaded)).toBe(true);
  });
});

describe('init migration — decline flow', () => {
  it('records decline + 30-day suppression; manifest preserved', async () => {
    await writeFile(join(projectDir, 'MEMORY.md'), FIXTURE);
    const candidates = await detectCandidates(projectDir);
    const manifest = await loadManifest(PROJECT_ID);
    const now = new Date('2026-05-07T00:00:00Z');
    await recordDecline(manifest, candidates[0], now);

    // Original unchanged after a decline.
    expect(await readFile(join(projectDir, 'MEMORY.md'), 'utf-8')).toBe(FIXTURE);

    // Within 30 days → suppressed.
    const day29 = new Date(now.getTime() + 29 * 24 * 3600 * 1000);
    const reloaded = await loadManifest(PROJECT_ID);
    expect(isDeclineSuppressed(candidates[0], reloaded, day29)).toBe(true);

    // After 30 days → re-prompt allowed.
    const day31 = new Date(now.getTime() + 31 * 24 * 3600 * 1000);
    expect(isDeclineSuppressed(candidates[0], reloaded, day31)).toBe(false);
  });
});

describe('init migration — multi-source', () => {
  it('detects MEMORY.md and CLAUDE.md work-section blocks together', async () => {
    await writeFile(join(projectDir, 'MEMORY.md'), '## Decisions\n- A\n');
    await writeFile(
      join(projectDir, 'CLAUDE.md'),
      '## Setup\nBoilerplate.\n\n## Patterns\n- Always X\n',
    );
    const candidates = await detectCandidates(projectDir);
    const kinds = candidates.map((c) => c.kind).sort();
    expect(kinds).toEqual(['memory_md', 'project_claude_md']);
  });
});
