import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  parseEntries,
  detectCandidates,
  backupAndStub,
  loadManifest,
  recordMigration,
  recordDecline,
  isAlreadyMigrated,
  isDeclineSuppressed,
  renderPreview,
} from '../../src/hooks/migration.js';

const PROJECT_ID = '11111111-1111-1111-1111-111111111111';

let tempHome: string;
let projectDir: string;
let prevValisHome: string | undefined;

beforeEach(async () => {
  tempHome = await mkdtemp(join(tmpdir(), 'valis-migration-home-'));
  projectDir = await mkdtemp(join(tmpdir(), 'valis-migration-proj-'));
  prevValisHome = process.env.VALIS_HOME;
  process.env.VALIS_HOME = tempHome;
});

afterEach(async () => {
  if (prevValisHome === undefined) delete process.env.VALIS_HOME;
  else process.env.VALIS_HOME = prevValisHome;
  await rm(tempHome, { recursive: true, force: true });
  await rm(projectDir, { recursive: true, force: true });
});

describe('hooks/migration — parseEntries', () => {
  it('extracts bullets under headings as entries', () => {
    const md = `# Project rules

## Decisions
- Use TTL + own-write cache invalidation
- Prefer Vercel over Netlify

## Patterns
- Always wrap fetch with AbortController
`;
    const entries = parseEntries(md);
    expect(entries.length).toBe(3);
    expect(entries[0].summary).toContain('Use TTL');
    expect(entries[0].affects).toContain('Decisions');
    expect(entries[2].affects).toContain('Patterns');
  });

  it('tags constraint vs pattern vs lesson vs decision via heuristic', () => {
    const md = `## Notes
- Never store secrets in git history
- Always use AbortController to bound fetch lifetimes
- Lesson: silent zero on Qdrant filter when index is missing
- Use TTL + own-write cache invalidation
`;
    const entries = parseEntries(md);
    expect(entries[0].type).toBe('constraint');
    expect(entries[1].type).toBe('pattern');
    expect(entries[2].type).toBe('lesson');
    expect(entries[3].type).toBe('decision');
  });

  it('truncates summary at 200 characters with ellipsis', () => {
    const long = 'X'.repeat(500);
    const md = `## Decisions\n- ${long}\n`;
    const entries = parseEntries(md);
    expect(entries[0].summary.length).toBeLessThanOrEqual(200);
    expect(entries[0].summary.endsWith('…')).toBe(true);
  });

  it('returns empty array on whitespace-only input', () => {
    expect(parseEntries('   \n\n   \n').length).toBe(0);
  });
});

describe('hooks/migration — detectCandidates', () => {
  it('finds MEMORY.md when present', async () => {
    await writeFile(
      join(projectDir, 'MEMORY.md'),
      '## Decisions\n- Use TTL\n- Use ETag\n',
    );
    const candidates = await detectCandidates(projectDir);
    expect(candidates.length).toBe(1);
    expect(candidates[0].kind).toBe('memory_md');
    expect(candidates[0].entries.length).toBe(2);
    expect(candidates[0].sourceDedupHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('finds work-section blocks in CLAUDE.md', async () => {
    await writeFile(
      join(projectDir, 'CLAUDE.md'),
      `# Project Setup
## Setup
This is boilerplate.

## Decisions
- Use Supabase
- Use Qdrant for vectors
`,
    );
    const candidates = await detectCandidates(projectDir);
    expect(candidates.length).toBe(1);
    expect(candidates[0].kind).toBe('project_claude_md');
    expect(candidates[0].entries.length).toBe(2);
    expect(candidates[0].entries[0].summary).toContain('Supabase');
  });

  it('returns empty when no markers exist', async () => {
    const candidates = await detectCandidates(projectDir);
    expect(candidates).toEqual([]);
  });

  it('skips files that have no parseable entries', async () => {
    await writeFile(join(projectDir, 'MEMORY.md'), '# Title\n\nFree-form prose with no bullets.\n');
    const candidates = await detectCandidates(projectDir);
    expect(candidates).toEqual([]);
  });

  it('produces a stable dedup hash across reads', async () => {
    await writeFile(join(projectDir, 'MEMORY.md'), '## D\n- foo\n');
    const a = await detectCandidates(projectDir);
    const b = await detectCandidates(projectDir);
    expect(a[0].sourceDedupHash).toBe(b[0].sourceDedupHash);
  });
});

describe('hooks/migration — manifest persistence', () => {
  it('returns an empty manifest when none exists', async () => {
    const m = await loadManifest(PROJECT_ID);
    expect(m.manifest_version).toBe(1);
    expect(m.migrations).toEqual([]);
    expect(m.decline_history).toEqual([]);
  });

  it('round-trips recordMigration → loadManifest', async () => {
    await writeFile(join(projectDir, 'MEMORY.md'), '## D\n- A\n- B\n');
    const candidates = await detectCandidates(projectDir);
    const candidate = candidates[0];

    let manifest = await loadManifest(PROJECT_ID);
    manifest.project_name = 'valis';
    const backup = await backupAndStub(candidate, PROJECT_ID);
    await recordMigration(manifest, {
      candidate,
      backupPath: backup,
      decisionIds: ['dec-1', 'dec-2'],
      migratedAt: new Date().toISOString(),
    });

    const reloaded = await loadManifest(PROJECT_ID);
    expect(reloaded.migrations.length).toBe(1);
    expect(reloaded.migrations[0].decision_ids.length).toBe(2);
    expect(reloaded.migrations[0].source_dedup_hash).toBe(candidate.sourceDedupHash);
  });

  it('isAlreadyMigrated returns true for known hashes', async () => {
    await writeFile(join(projectDir, 'MEMORY.md'), '## D\n- A\n');
    const c = (await detectCandidates(projectDir))[0];
    const manifest = await loadManifest(PROJECT_ID);
    expect(isAlreadyMigrated(c, manifest)).toBe(false);
    manifest.migrations.push({
      migrated_at: new Date().toISOString(),
      source_path: c.path,
      source_dedup_hash: c.sourceDedupHash,
      backup_path: '/tmp/x',
      entries_migrated: 1,
      decision_ids: ['d'],
    });
    expect(isAlreadyMigrated(c, manifest)).toBe(true);
  });

  it('isDeclineSuppressed returns true within 30 days, false after', async () => {
    await writeFile(join(projectDir, 'MEMORY.md'), '## D\n- A\n');
    const c = (await detectCandidates(projectDir))[0];
    const manifest = await loadManifest(PROJECT_ID);
    const now = new Date('2026-05-06T00:00:00Z');
    await recordDecline(manifest, c, now);

    const day29 = new Date(now.getTime() + 29 * 24 * 3600 * 1000);
    const day31 = new Date(now.getTime() + 31 * 24 * 3600 * 1000);
    expect(isDeclineSuppressed(c, manifest, day29)).toBe(true);
    expect(isDeclineSuppressed(c, manifest, day31)).toBe(false);
  });
});

describe('hooks/migration — backupAndStub', () => {
  it('copies the original to ~/.valis/migrate-backup and writes a stub pointer', async () => {
    const original = '## Decisions\n- Use TTL\n';
    const memoryPath = join(projectDir, 'MEMORY.md');
    await writeFile(memoryPath, original);

    const candidates = await detectCandidates(projectDir);
    const backup = await backupAndStub(candidates[0], PROJECT_ID);

    // Backup retains original content.
    expect(await readFile(backup, 'utf-8')).toBe(original);
    // Backup path is under ~/.valis/migrate-backup/<project_id>/
    expect(backup).toContain(join(tempHome, 'migrate-backup', PROJECT_ID));

    // Original is replaced with a pointer that mentions the backup path.
    const replaced = await readFile(memoryPath, 'utf-8');
    expect(replaced).toContain('Memory has moved to Valis');
    expect(replaced).toContain(backup);
  });

  it('does NOT clobber the original if the backup-write fails', async () => {
    // Force backup directory to be read-only by pointing VALIS_HOME at a
    // non-writable parent. We approximate this by clobbering the env var
    // with a path that resolves to /dev/null on POSIX.
    if (process.platform === 'win32') return;
    process.env.VALIS_HOME = '/dev/null/forbidden';
    const memoryPath = join(projectDir, 'MEMORY.md');
    const original = '## Decisions\n- Use TTL\n';
    await writeFile(memoryPath, original);
    const candidate = (await detectCandidates(projectDir))[0];

    let threw = false;
    try {
      await backupAndStub(candidate, PROJECT_ID);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    expect(await readFile(memoryPath, 'utf-8')).toBe(original);
  });
});

describe('hooks/migration — renderPreview', () => {
  it('lists candidates and a sample of entries', async () => {
    await writeFile(
      join(projectDir, 'MEMORY.md'),
      '## D\n- Foo\n- Bar\n- Baz\n- Qux\n',
    );
    const candidates = await detectCandidates(projectDir);
    const out = renderPreview(candidates);
    expect(out).toContain('Valis detected competing memory content');
    expect(out).toContain('MEMORY.md');
    expect(out).toMatch(/\[(decision|pattern|lesson|constraint)\]/);
  });
});
