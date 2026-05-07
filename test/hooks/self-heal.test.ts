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
  await rm(tempHome, { recursive: true, force: true });
  await rm(claudeHomeDir, { recursive: true, force: true });
  await rm(projectDir, { recursive: true, force: true });
});

async function writeGlobalClaudeMd(content: string): Promise<void> {
  await mkdir(claudeHomeDir, { recursive: true });
  await writeFile(join(claudeHomeDir, 'CLAUDE.md'), content);
}

describe('self-heal — global ~/.claude/CLAUDE.md', () => {
  it('repairs absent markers by appending canonical block', async () => {
    await writeGlobalClaudeMd('# Existing user content\n\nSome notes.\n');

    const reports = await runSelfHeal({ projectDir, silent: true });
    const global = reports.find((r) => r.target.includes('Knowledge Retention'));
    expect(global?.outcome).toBe('repaired');

    const after = await readFile(join(claudeHomeDir, 'CLAUDE.md'), 'utf-8');
    expect(after).toContain(GLOBAL_KR_START);
    expect(after).toContain(GLOBAL_KR_END);
    expect(after).toContain('Two-layer model');
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
          PostToolUse: [{ hooks: [{ type: 'command', command: 'valis hook post-tool-use' }] }],
          PreToolUse: [{ hooks: [{ type: 'command', command: 'valis hook pre-tool-use' }] }],
          PreCompact: [{ hooks: [{ type: 'command', command: 'valis hook pre-compact' }] }],
          Stop: [{ hooks: [{ type: 'command', command: 'valis hook stop' }] }],
        },
      }),
    );

    const t0 = performance.now();
    const reports = await runSelfHeal({ projectDir, silent: true });
    const elapsed = performance.now() - t0;
    expect(reports.every((r) => r.outcome === 'fresh')).toBe(true);
    expect(elapsed).toBeLessThan(50);
  });
});
