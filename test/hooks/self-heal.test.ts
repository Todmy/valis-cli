/**
 * Self-heal hook regression suite — feature 023 v2 follow-up.
 *
 * Coverage:
 *   - drift detection (markers absent → repair)
 *   - idempotency (markers + canonical content → fresh, no write)
 *   - user customization (markers + drifted content → user_customized, no write)
 *   - opt-out via auto_heal:false
 *   - skipped when target file absent
 *   - canonical-content hash stable across runs
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  runSelfHeal,
  applyGlobalKrSection,
  __internal,
} from '../../src/hooks/self-heal.js';
import {
  GLOBAL_KR_START,
  GLOBAL_KR_END,
  GLOBAL_KR_BODY,
  canonicalGlobalKrBlock,
} from '../../src/hooks/self-heal-templates.js';

let tempHome: string;
let claudeHomeDir: string;
let projectDir: string;
let prevValisHome: string | undefined;
let prevClaudeHome: string | undefined;

beforeEach(async () => {
  tempHome = await mkdtemp(join(tmpdir(), 'valis-heal-home-'));
  claudeHomeDir = await mkdtemp(join(tmpdir(), 'valis-heal-claude-'));
  projectDir = await mkdtemp(join(tmpdir(), 'valis-heal-proj-'));
  prevValisHome = process.env.VALIS_HOME;
  prevClaudeHome = process.env.CLAUDE_CONFIG_HOME;
  process.env.VALIS_HOME = tempHome;
  process.env.CLAUDE_CONFIG_HOME = claudeHomeDir;
});

afterEach(async () => {
  if (prevValisHome === undefined) delete process.env.VALIS_HOME;
  else process.env.VALIS_HOME = prevValisHome;
  if (prevClaudeHome === undefined) delete process.env.CLAUDE_CONFIG_HOME;
  else process.env.CLAUDE_CONFIG_HOME = prevClaudeHome;
  await rm(tempHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  await rm(claudeHomeDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  await rm(projectDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

async function writeGlobalClaudeMd(content: string): Promise<void> {
  await mkdir(claudeHomeDir, { recursive: true });
  await writeFile(join(claudeHomeDir, 'CLAUDE.md'), content);
}

describe('self-heal — global ~/.claude/CLAUDE.md', () => {
  it('first-time install prepends the canonical block at the top of the file', async () => {
    await writeGlobalClaudeMd('# Existing user content\n\nSome notes.\n');

    const reports = await runSelfHeal({ projectDir, silent: true });
    const global = reports.find((r) => r.target.includes('Knowledge Retention'));
    expect(global?.outcome).toBe('repaired');

    const after = await readFile(join(claudeHomeDir, 'CLAUDE.md'), 'utf-8');
    expect(after).toContain(GLOBAL_KR_START);
    expect(after).toContain(GLOBAL_KR_END);
    expect(after).toContain('Two-layer model');
    // Position: KR block must precede the pre-existing user content so it
    // wins attention weight against competing top-of-file hooks (lesson
    // d29548c3 — Qdrant SessionStart hook dominated Valis at EOF).
    expect(after.indexOf(GLOBAL_KR_START)).toBeLessThan(
      after.indexOf('# Existing user content'),
    );
  });

  it('first-time install on empty file just writes the block', async () => {
    await writeGlobalClaudeMd('');
    await runSelfHeal({ projectDir, silent: true });
    const after = await readFile(join(claudeHomeDir, 'CLAUDE.md'), 'utf-8');
    expect(after.startsWith(GLOBAL_KR_START)).toBe(true);
  });

  it('preserves user-relocated block on subsequent runs (idempotent on position)', async () => {
    // User does first install (prepend), then manually moves the block to
    // mid-file because they want their identity content first. Re-running
    // self-heal MUST NOT yank it back to the top.
    const userIdentity = '# My Identity\n\nI am Dmytro.\n';
    const valisBlock = canonicalGlobalKrBlock();
    const trailing = '\n# Tools\n\nMy tools list.\n';
    await writeGlobalClaudeMd(userIdentity + '\n' + valisBlock + trailing);

    const reports = await runSelfHeal({ projectDir, silent: true });
    expect(reports.find((r) => r.target.includes('Knowledge Retention'))?.outcome).toBe('fresh');

    const after = await readFile(join(claudeHomeDir, 'CLAUDE.md'), 'utf-8');
    // User's identity block stays first.
    expect(after.indexOf('# My Identity')).toBeLessThan(after.indexOf(GLOBAL_KR_START));
    // Tools section stays after.
    expect(after.indexOf('# Tools')).toBeGreaterThan(after.indexOf(GLOBAL_KR_END));
  });

  it('replaces an existing "# Knowledge Retention" section in place', async () => {
    const before = `# Tone of Voice

Old tone notes.

# Knowledge Retention (Qdrant)

Old Qdrant-only instructions.
- Do this
- Do that

# Some Other Section

Other content.
`;
    await writeGlobalClaudeMd(before);

    const reports = await runSelfHeal({ projectDir, silent: true });
    expect(reports.find((r) => r.target.includes('Knowledge Retention'))?.outcome).toBe('repaired');

    const after = await readFile(join(claudeHomeDir, 'CLAUDE.md'), 'utf-8');
    expect(after).toContain('# Tone of Voice');
    expect(after).toContain('# Some Other Section');
    expect(after).toContain('Two-layer model');
    expect(after).not.toContain('Old Qdrant-only instructions');
    expect(after).toContain(GLOBAL_KR_START);
  });

  it('idempotent: second run on canonical content reports fresh', async () => {
    await writeGlobalClaudeMd('# Top\n\n' + canonicalGlobalKrBlock() + '\n');

    const r1 = await runSelfHeal({ projectDir, silent: true });
    const r2 = await runSelfHeal({ projectDir, silent: true });
    expect(r1.find((r) => r.target.includes('Knowledge Retention'))?.outcome).toBe('fresh');
    expect(r2.find((r) => r.target.includes('Knowledge Retention'))?.outcome).toBe('fresh');
  });

  it('respects user customization: drifted content inside markers is left alone', async () => {
    const customBody = 'Custom user content the engineer wrote themselves.';
    const wrapped = `${GLOBAL_KR_START}\n${customBody}\n${GLOBAL_KR_END}`;
    await writeGlobalClaudeMd(`# Top\n\n${wrapped}\n`);

    const reports = await runSelfHeal({ projectDir, silent: true });
    expect(reports.find((r) => r.target.includes('Knowledge Retention'))?.outcome).toBe(
      'user_customized',
    );

    const after = await readFile(join(claudeHomeDir, 'CLAUDE.md'), 'utf-8');
    expect(after).toContain(customBody);
    expect(after).not.toContain('Two-layer model');
  });

  it('skipped when global CLAUDE.md does not exist', async () => {
    const reports = await runSelfHeal({ projectDir, silent: true });
    expect(reports.find((r) => r.target.includes('Knowledge Retention'))?.outcome).toBe('skipped');
  });

  it('writes a backup before overwriting', async () => {
    const original = '# Existing\n\nUser content.\n';
    await writeGlobalClaudeMd(original);

    await runSelfHeal({ projectDir, silent: true });

    // Backup root: $VALIS_HOME/migrate-backup/self-heal/global-claude-md/<ts>/CLAUDE.md
    const { readdirSync } = await import('node:fs');
    const root = join(tempHome, 'migrate-backup', 'self-heal', 'global-claude-md');
    const entries = readdirSync(root);
    expect(entries.length).toBeGreaterThan(0);
    const ts = entries[0];
    const backup = await readFile(join(root, ts, 'CLAUDE.md'), 'utf-8');
    expect(backup).toBe(original);
  });
});

describe('self-heal — project <dir>/CLAUDE.md markers', () => {
  it('skipped when project CLAUDE.md absent', async () => {
    const reports = await runSelfHeal({ projectDir, silent: true });
    expect(reports.find((r) => r.target.includes('valis:start markers'))?.outcome).toBe('skipped');
  });

  it('reports fresh when project markers present', async () => {
    await writeFile(
      join(projectDir, 'CLAUDE.md'),
      '# Project\n\n<!-- valis:start -->\nSome valis content.\n<!-- valis:end -->\n',
    );
    const reports = await runSelfHeal({ projectDir, silent: true });
    expect(reports.find((r) => r.target.includes('valis:start markers'))?.outcome).toBe('fresh');
  });
});

describe('self-heal — opt-out', () => {
  it('returns single opt_out report when auto_heal:false', async () => {
    await mkdir(tempHome, { recursive: true });
    await writeFile(
      join(tempHome, 'config.json'),
      JSON.stringify({ org_id: 'o', auto_heal: false }),
    );
    await writeGlobalClaudeMd('# Existing user content\n\nSome notes.\n');

    const reports = await runSelfHeal({ projectDir, silent: true });
    expect(reports.length).toBe(1);
    expect(reports[0].outcome).toBe('opt_out');

    // Confirm no rewrite happened.
    const after = await readFile(join(claudeHomeDir, 'CLAUDE.md'), 'utf-8');
    expect(after).not.toContain(GLOBAL_KR_START);
  });
});

describe('self-heal — applyGlobalKrSection (pure)', () => {
  it('appends when no Knowledge Retention heading exists', () => {
    const out = applyGlobalKrSection('# Foo\n\nBar.\n');
    expect(out).toContain('# Foo');
    expect(out).toContain(GLOBAL_KR_START);
    expect(out.endsWith('\n')).toBe(true);
  });

  it('replaces in place when a Knowledge Retention heading exists', () => {
    const before = '# A\n\nAA.\n\n# Knowledge Retention (Qdrant)\n\nOld.\n\n# B\n\nBB.\n';
    const out = applyGlobalKrSection(before);
    expect(out).toContain('# A');
    expect(out).toContain('# B');
    expect(out).toContain(GLOBAL_KR_START);
    expect(out).not.toContain('Old.');
  });

  it('is idempotent: applying twice produces equivalent content', () => {
    const a = applyGlobalKrSection('# Top\n\n');
    const b = applyGlobalKrSection(a);
    // Hash the canonical body in both — must match exactly.
    const extract = (s: string) =>
      s.slice(s.indexOf(GLOBAL_KR_START) + GLOBAL_KR_START.length, s.indexOf(GLOBAL_KR_END));
    expect(__internal.contentHash(extract(a))).toBe(__internal.contentHash(extract(b)));
  });
});

describe('self-heal — canonical hash stability', () => {
  it('canonical body hash is reproducible across runs', () => {
    expect(__internal.contentHash(GLOBAL_KR_BODY)).toBe(__internal.CANONICAL_GLOBAL_KR_HASH);
  });
});

describe('self-heal — global KR failure-mode contract', () => {
  // Regression pins: when Valis fails the agent must NOT silently fall back
  // to qdrant / mem0 / etc., or team-level decisions land in a per-user
  // scratchpad (silent data loss). v0.5.4 fix — removing this clause
  // re-opens the bug.
  it('canonical body declares the failure-mode contract', () => {
    expect(GLOBAL_KR_BODY).toContain('Failure-mode contract');
  });

  it('canonical body forbids silent fallback to Qdrant / mem0', () => {
    expect(GLOBAL_KR_BODY).toMatch(/Do not silently fall back/i);
  });

  it('canonical body names the OAuth and CLI recovery paths', () => {
    expect(GLOBAL_KR_BODY).toContain('/mcp');
    expect(GLOBAL_KR_BODY).toContain('valis login');
  });
});

describe('self-heal — MCP entry in ~/.claude.json', () => {
  beforeEach(() => {
    process.env.CLAUDE_HOME_OVERRIDE = claudeHomeDir;
  });
  afterEach(() => {
    delete process.env.CLAUDE_HOME_OVERRIDE;
  });

  it('skipped when ~/.claude.json absent', async () => {
    const reports = await runSelfHeal({ projectDir, silent: true });
    expect(reports.find((r) => r.target.includes('mcpServers.valis'))?.outcome).toBe('skipped');
  });

  it('repaired when valis MCP entry missing', async () => {
    await mkdir(claudeHomeDir, { recursive: true });
    await writeFile(
      join(claudeHomeDir, '.claude.json'),
      JSON.stringify({ mcpServers: { other: { command: 'something' } } }),
    );
    const reports = await runSelfHeal({ projectDir, silent: true });
    expect(reports.find((r) => r.target.includes('mcpServers.valis'))?.outcome).toBe('repaired');

    const after = JSON.parse(await readFile(join(claudeHomeDir, '.claude.json'), 'utf-8'));
    expect(after.mcpServers.valis.command).toBe('valis');
    expect(after.mcpServers.valis.args).toEqual(['serve']);
    expect(after.mcpServers.other).toBeTruthy();
  });

  it('fresh when valis MCP entry already correct', async () => {
    await mkdir(claudeHomeDir, { recursive: true });
    await writeFile(
      join(claudeHomeDir, '.claude.json'),
      JSON.stringify({
        mcpServers: { valis: { command: 'valis', args: ['serve'], env: {} } },
      }),
    );
    const reports = await runSelfHeal({ projectDir, silent: true });
    expect(reports.find((r) => r.target.includes('mcpServers.valis'))?.outcome).toBe('fresh');
  });

  it('skipped on malformed JSON', async () => {
    await mkdir(claudeHomeDir, { recursive: true });
    await writeFile(join(claudeHomeDir, '.claude.json'), '{not valid');
    const reports = await runSelfHeal({ projectDir, silent: true });
    expect(reports.find((r) => r.target.includes('mcpServers.valis'))?.outcome).toBe('skipped');
  });
});

describe('self-heal — installation_id recovery', () => {
  it('writes a UUID when file is absent', async () => {
    const reports = await runSelfHeal({ projectDir, silent: true });
    const inst = reports.find((r) => r.target.includes('installation-id'));
    expect(inst?.outcome).toBe('repaired');
    const id = (await readFile(join(tempHome, 'installation-id'), 'utf-8')).trim();
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });

  it('preserves an existing valid UUID across runs', async () => {
    await mkdir(tempHome, { recursive: true });
    const original = '11111111-2222-3333-4444-555555555555';
    await writeFile(join(tempHome, 'installation-id'), original);

    await runSelfHeal({ projectDir, silent: true });
    const after = (await readFile(join(tempHome, 'installation-id'), 'utf-8')).trim();
    expect(after).toBe(original);
  });

  it('overwrites garbled content but backs up first', async () => {
    await mkdir(tempHome, { recursive: true });
    await writeFile(join(tempHome, 'installation-id'), 'definitely-not-a-uuid\n');

    await runSelfHeal({ projectDir, silent: true });
    const after = (await readFile(join(tempHome, 'installation-id'), 'utf-8')).trim();
    expect(after).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(after).not.toBe('definitely-not-a-uuid');

    // Backup written.
    const { readdirSync } = await import('node:fs');
    const root = join(tempHome, 'migrate-backup', 'self-heal', 'installation-id');
    expect(readdirSync(root).length).toBeGreaterThan(0);
  });
});

describe('self-heal — auto-memory MEMORY.md drift (D)', () => {
  const PROJECT_ID = '11111111-1111-1111-1111-111111111111';

  function autoMemoryPath(): string {
    const encoded = projectDir.replace(/\//g, '-');
    return join(claudeHomeDir, 'projects', encoded, 'memory', 'MEMORY.md');
  }

  it('skipped when auto-memory file does not exist', async () => {
    const reports = await runSelfHeal({ projectDir, projectId: PROJECT_ID, silent: true });
    const r = reports.find((x) => x.target.includes('memory/MEMORY.md'));
    expect(r?.outcome).toBe('skipped');
  });

  it('reports never_migrated when auto-memory exists but no manifest', async () => {
    const path = autoMemoryPath();
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, '## Notes\n- foo\n- bar\n');

    const reports = await runSelfHeal({ projectDir, projectId: PROJECT_ID, silent: true });
    const r = reports.find((x) => x.target.includes('memory/MEMORY.md'));
    expect(r?.outcome).toBe('repaired');
    expect(r?.notes).toMatch(/never migrated/);
  });

  it('reports fresh when manifest hash matches current file', async () => {
    const path = autoMemoryPath();
    const content = '## Notes\n- foo\n- bar\n';
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, content);

    const { createHash } = await import('node:crypto');
    const hash = createHash('sha256').update(content).digest('hex');

    const manifestDir = join(tempHome, 'migrate-backup', PROJECT_ID);
    await mkdir(manifestDir, { recursive: true });
    await writeFile(
      join(manifestDir, 'manifest.json'),
      JSON.stringify({
        manifest_version: 1,
        project_id: PROJECT_ID,
        project_name: 'x',
        migrations: [
          {
            migrated_at: '2026-05-01T00:00:00Z',
            source_path: path,
            source_dedup_hash: hash,
            backup_path: '/tmp/x',
            entries_migrated: 2,
            decision_ids: [],
          },
        ],
        decline_history: [],
      }),
    );

    const reports = await runSelfHeal({ projectDir, projectId: PROJECT_ID, silent: true });
    const r = reports.find((x) => x.target.includes('memory/MEMORY.md'));
    expect(r?.outcome).toBe('fresh');
  });

  it('reports drifted when manifest hash differs from current file', async () => {
    const path = autoMemoryPath();
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, '## Notes\n- new entry that postdates migration\n');

    const manifestDir = join(tempHome, 'migrate-backup', PROJECT_ID);
    await mkdir(manifestDir, { recursive: true });
    await writeFile(
      join(manifestDir, 'manifest.json'),
      JSON.stringify({
        manifest_version: 1,
        project_id: PROJECT_ID,
        project_name: 'x',
        migrations: [
          {
            migrated_at: '2026-05-01T00:00:00Z',
            source_path: path,
            source_dedup_hash: 'OLDHASH'.padEnd(64, '0'),
            backup_path: '/tmp/x',
            entries_migrated: 1,
            decision_ids: [],
          },
        ],
        decline_history: [],
      }),
    );

    const reports = await runSelfHeal({ projectDir, projectId: PROJECT_ID, silent: true });
    const r = reports.find((x) => x.target.includes('memory/MEMORY.md'));
    expect(r?.outcome).toBe('repaired');
    expect(r?.notes).toMatch(/drifted since/);
  });

  it('skipped when projectId is not provided', async () => {
    const reports = await runSelfHeal({ projectDir, silent: true });
    const r = reports.find((x) => x.target.includes('memory/MEMORY.md'));
    expect(r?.outcome).toBe('skipped');
    expect(r?.notes).toMatch(/no project_id/);
  });
});

describe('self-heal — .gitignore marker visibility (E)', () => {
  it('skipped when .gitignore absent', async () => {
    const reports = await runSelfHeal({ projectDir, silent: true });
    const r = reports.find((x) => x.target.includes('.gitignore'));
    expect(r?.outcome).toBe('skipped');
  });

  it('fresh when .gitignore does not block .valis.json', async () => {
    await writeFile(
      join(projectDir, '.gitignore'),
      'node_modules/\ndist/\n.env*\n',
    );
    const reports = await runSelfHeal({ projectDir, silent: true });
    const r = reports.find((x) => x.target.includes('.gitignore'));
    expect(r?.outcome).toBe('fresh');
  });

  it('flags user_customized when .gitignore explicitly ignores .valis.json', async () => {
    await writeFile(
      join(projectDir, '.gitignore'),
      'node_modules/\n.valis.json\ndist/\n',
    );
    const reports = await runSelfHeal({ projectDir, silent: true });
    const r = reports.find((x) => x.target.includes('.gitignore'));
    expect(r?.outcome).toBe('user_customized');
    expect(r?.notes).toMatch(/team members will not see/);
  });

  it('flags user_customized on over-broad *.json rule', async () => {
    await writeFile(join(projectDir, '.gitignore'), '*.json\n');
    const reports = await runSelfHeal({ projectDir, silent: true });
    const r = reports.find((x) => x.target.includes('.gitignore'));
    expect(r?.outcome).toBe('user_customized');
  });
});

describe('self-heal — Cursor MCP entry (F)', () => {
  let cursorHomeDir: string;
  let prevCursorHome: string | undefined;

  beforeEach(async () => {
    cursorHomeDir = await mkdtemp(join(tmpdir(), 'valis-cursor-'));
    prevCursorHome = process.env.CURSOR_HOME_OVERRIDE;
    process.env.CURSOR_HOME_OVERRIDE = cursorHomeDir;
  });

  afterEach(async () => {
    if (prevCursorHome === undefined) delete process.env.CURSOR_HOME_OVERRIDE;
    else process.env.CURSOR_HOME_OVERRIDE = prevCursorHome;
    await rm(cursorHomeDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it('skipped when ~/.cursor/mcp.json absent', async () => {
    const reports = await runSelfHeal({ projectDir, silent: true });
    const r = reports.find((x) => x.target.includes('cursor/mcp.json'));
    expect(r?.outcome).toBe('skipped');
  });

  it('repaired when valis MCP entry missing', async () => {
    await writeFile(
      join(cursorHomeDir, 'mcp.json'),
      JSON.stringify({ mcpServers: { other: { command: 'something' } } }),
    );
    const reports = await runSelfHeal({ projectDir, silent: true });
    const r = reports.find((x) => x.target.includes('cursor/mcp.json'));
    expect(r?.outcome).toBe('repaired');

    const after = JSON.parse(await readFile(join(cursorHomeDir, 'mcp.json'), 'utf-8'));
    expect(after.mcpServers.valis.command).toBe('valis');
    expect(after.mcpServers.valis.args).toEqual(['serve']);
    expect(after.mcpServers.other).toBeTruthy();
  });

  it('fresh when valis MCP entry already correct', async () => {
    await writeFile(
      join(cursorHomeDir, 'mcp.json'),
      JSON.stringify({
        mcpServers: { valis: { command: 'valis', args: ['serve'] } },
      }),
    );
    const reports = await runSelfHeal({ projectDir, silent: true });
    const r = reports.find((x) => x.target.includes('cursor/mcp.json'));
    expect(r?.outcome).toBe('fresh');
  });
});

describe('self-heal — performance smoke', () => {
  it('fresh-state path completes under 50ms (substring probes only)', async () => {
    await writeGlobalClaudeMd('# Top\n\n' + canonicalGlobalKrBlock() + '\n');
    await writeFile(
      join(projectDir, 'CLAUDE.md'),
      '# P\n<!-- valis:start -->\nx\n<!-- valis:end -->\n',
    );
    await mkdir(claudeHomeDir, { recursive: true });
    await writeFile(
      join(claudeHomeDir, 'settings.json'),
      JSON.stringify({
        hooks: {
          SessionStart: [{ hooks: [{ type: 'command', command: 'valis hook session-start' }] }],
          UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'valis hook user-prompt-submit' }] }],
          PreToolUse: [{ hooks: [{ type: 'command', command: 'valis hook pre-tool-use' }] }],
          PreCompact: [{ hooks: [{ type: 'command', command: 'valis hook pre-compact' }] }],
          Stop: [{ hooks: [{ type: 'command', command: 'valis hook stop' }] }],
        },
      }),
    );

    // Pre-seed the new heal targets so this run truly is "everything fresh".
    await mkdir(claudeHomeDir, { recursive: true });
    await writeFile(
      join(claudeHomeDir, '.claude.json'),
      JSON.stringify({
        mcpServers: { valis: { command: 'valis', args: ['serve'], env: {} } },
      }),
    );
    await writeFile(
      join(tempHome, 'installation-id'),
      '11111111-2222-3333-4444-555555555555',
    );
    process.env.CLAUDE_HOME_OVERRIDE = claudeHomeDir;

    const t0 = performance.now();
    const reports = await runSelfHeal({ projectDir, silent: true });
    const elapsed = performance.now() - t0;
    delete process.env.CLAUDE_HOME_OVERRIDE;

    // Latency budget is the load-bearing assertion. Outcomes vary by which
    // optional surfaces are pre-seeded; we only require the seeded ones
    // (Knowledge Retention, project markers, settings hooks, MCP entry,
    // installation_id) to be `fresh`. Auto-memory / gitignore / cursor
    // heals legitimately return `skipped` when those surfaces are absent.
    const seeded = reports.filter((r) =>
      [
        'Knowledge Retention',
        'valis:start markers',
        'valis hooks',
        'mcpServers.valis',
        'installation-id',
      ].some((needle) => r.target.includes(needle)),
    );
    expect(seeded.length).toBeGreaterThanOrEqual(5);
    expect(seeded.every((r) => r.outcome === 'fresh')).toBe(true);
    expect(elapsed).toBeLessThan(50);
  });
});
