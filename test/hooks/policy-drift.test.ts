/**
 * gh#340 (option A) — a frozen block must be visible and recoverable.
 *
 * Option C fixed the future: blocks written from now on carry regions and
 * upgrade themselves. This is the other half — the blocks already edited in
 * place, which have no regions, match no historical hash, and have therefore
 * been skipped by every policy bump in total silence. The author's own global
 * CLAUDE.md is one of them, 1,904 sessions deep.
 *
 * Two properties are load-bearing and asserted here:
 *   · migration is not a choice between losing your text and staying behind —
 *     the user's lines survive AND the policy lands;
 *   · nothing writes without an explicit decision, and never over a malformed
 *     block.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  GLOBAL_KR_START,
  GLOBAL_KR_END,
  GLOBAL_KR_BODY,
  PROJECT_VALIS_START,
  PROJECT_VALIS_END,
  KR_POLICY_VERSION,
  POLICY_VERSION_HISTORY,
  canonicalGlobalKrBlock,
  policyMarkerLine,
  CUSTOM_REGION_START,
  CUSTOM_REGION_END,
  hasManagedRegions,
} from '../../src/hooks/self-heal-templates.js';
import {
  detectPolicyDrift,
  needsAttention,
  migratable,
  extractAdditions,
} from '../../src/hooks/policy-drift.js';
import { migrateBlock } from '../../src/commands/doctor.js';
import { injectClaudeMdMarkers, AGENT_INSTRUCTIONS } from '../../src/ide/claude-code.js';
import { maybeNoticePolicyDrift } from '../../src/hooks/session-start-handler.js';

const MINE_A = 'Always answer me in Ukrainian.';
const MINE_B = 'Never touch the deploy script without asking.';
const PREVIOUS = POLICY_VERSION_HISTORY[POLICY_VERSION_HISTORY.length - 2];

describe('gh#340 A — detection', () => {
  let claudeHomeDir: string;
  let projectDir: string;
  let prevClaudeHome: string | undefined;

  beforeEach(async () => {
    claudeHomeDir = await mkdtemp(join(tmpdir(), 'valis-drift-claude-'));
    projectDir = await mkdtemp(join(tmpdir(), 'valis-drift-proj-'));
    prevClaudeHome = process.env.CLAUDE_CONFIG_HOME;
    process.env.CLAUDE_CONFIG_HOME = claudeHomeDir;
  });

  afterEach(async () => {
    if (prevClaudeHome === undefined) delete process.env.CLAUDE_CONFIG_HOME;
    else process.env.CLAUDE_CONFIG_HOME = prevClaudeHome;
    for (const d of [claudeHomeDir, projectDir]) {
      await rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  /** A legacy (region-less) block on an older policy, with the user's lines in it. */
  function frozenGlobalBlock(): string {
    const body = `${policyMarkerLine(PREVIOUS)}\n\n# Knowledge Retention\n\nSome older policy text.\n\n${MINE_A}\n${MINE_B}`;
    return `${GLOBAL_KR_START}\n${body}\n${GLOBAL_KR_END}`;
  }

  it('a hand-edited legacy block reports as frozen, with how far behind it is', async () => {
    await writeFile(join(claudeHomeDir, 'CLAUDE.md'), `# Mine\n\n${frozenGlobalBlock()}\n`);

    const [global] = await detectPolicyDrift();
    expect(global.state).toBe('frozen');
    expect(global.blockVersion).toBe(PREVIOUS);
    expect(global.generationsBehind).toBe(1);
    expect(global.additions).toContain(MINE_A);
    expect(global.additions).toContain(MINE_B);
  });

  it('a block with no version marker at all is counted from the beginning', async () => {
    const body = `# Knowledge Retention\n\nAncient text.\n\n${MINE_A}`;
    await writeFile(
      join(claudeHomeDir, 'CLAUDE.md'),
      `${GLOBAL_KR_START}\n${body}\n${GLOBAL_KR_END}\n`,
    );

    const [global] = await detectPolicyDrift();
    expect(global.state).toBe('frozen');
    expect(global.blockVersion).toBeNull();
    expect(global.generationsBehind).toBe(POLICY_VERSION_HISTORY.length - 1);
  });

  it('a managed block is not reported — it upgrades itself', async () => {
    await writeFile(join(claudeHomeDir, 'CLAUDE.md'), `${canonicalGlobalKrBlock()}\n`);
    const [global] = await detectPolicyDrift();
    expect(global.state).toBe('current');
    expect(needsAttention([global])).toEqual([]);
  });

  it('a duplicated marker is reported as malformed and never offered for migration', async () => {
    await writeFile(
      join(claudeHomeDir, 'CLAUDE.md'),
      `${canonicalGlobalKrBlock()}\n\nI quote ${GLOBAL_KR_END} in my notes.\n`,
    );
    const [global] = await detectPolicyDrift();
    expect(global.state).toBe('malformed');
    expect(needsAttention([global])).toHaveLength(1);
  });

  it('an absent file is absent, not a problem', async () => {
    const [global] = await detectPolicyDrift();
    expect(global.state).toBe('absent');
    expect(needsAttention([global])).toEqual([]);
  });

  it('additions are the lines canonical does not have — markers never count', () => {
    const block = `${policyMarkerLine(PREVIOUS)}\n${GLOBAL_KR_BODY}\n${MINE_A}`;
    const additions = extractAdditions(block, GLOBAL_KR_BODY);
    expect(additions).toContain(MINE_A);
    expect(additions.some((l) => l.includes('valis:policy-version'))).toBe(false);
  });

  it('the project surface is inspected too', async () => {
    const body = `${policyMarkerLine(PREVIOUS)}\n\nOld project policy.\n\n${MINE_B}`;
    await writeFile(
      join(projectDir, 'CLAUDE.md'),
      `${PROJECT_VALIS_START}\n${body}\n${PROJECT_VALIS_END}\n`,
    );
    const drifts = await detectPolicyDrift(projectDir);
    const project = drifts.find((d) => d.surface === 'project')!;
    expect(project.state).toBe('frozen');
    expect(project.additions).toContain(MINE_B);
  });
});

describe('gh#340 A — migration keeps the text AND lands the policy', () => {
  let claudeHomeDir: string;
  let projectDir: string;
  let valisHomeDir: string;
  let prevClaudeHome: string | undefined;
  let prevValisHome: string | undefined;

  beforeEach(async () => {
    claudeHomeDir = await mkdtemp(join(tmpdir(), 'valis-mig-claude-'));
    projectDir = await mkdtemp(join(tmpdir(), 'valis-mig-proj-'));
    valisHomeDir = await mkdtemp(join(tmpdir(), 'valis-mig-home-'));
    prevClaudeHome = process.env.CLAUDE_CONFIG_HOME;
    prevValisHome = process.env.VALIS_HOME;
    process.env.CLAUDE_CONFIG_HOME = claudeHomeDir;
    process.env.VALIS_HOME = valisHomeDir;
  });

  afterEach(async () => {
    if (prevClaudeHome === undefined) delete process.env.CLAUDE_CONFIG_HOME;
    else process.env.CLAUDE_CONFIG_HOME = prevClaudeHome;
    if (prevValisHome === undefined) delete process.env.VALIS_HOME;
    else process.env.VALIS_HOME = prevValisHome;
    for (const d of [claudeHomeDir, projectDir, valisHomeDir]) {
      await rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it('global: the user keeps their lines and gets the current policy', async () => {
    const body = `${policyMarkerLine(PREVIOUS)}\n\n# Knowledge Retention\n\nOld text.\n\n${MINE_A}\n${MINE_B}`;
    const file = `# Above\n\n${GLOBAL_KR_START}\n${body}\n${GLOBAL_KR_END}\n\n# Below\n`;
    await writeFile(join(claudeHomeDir, 'CLAUDE.md'), file);

    const [global] = await detectPolicyDrift();
    const backupPath = await migrateBlock(global);

    const after = await readFile(join(claudeHomeDir, 'CLAUDE.md'), 'utf-8');
    // Their text: both lines, inside the region Valis never edits.
    const custom = after.split(CUSTOM_REGION_START)[1].split(CUSTOM_REGION_END)[0];
    expect(custom).toContain(MINE_A);
    expect(custom).toContain(MINE_B);
    // The policy: current version, canonical body.
    expect(after).toContain(`valis:policy-version:${KR_POLICY_VERSION}`);
    expect(after).toContain('MIRROR-WRITE');
    // Everything outside the markers is untouched.
    expect(after).toContain('# Above');
    expect(after).toContain('# Below');
    // And the original is recoverable.
    expect(await readFile(backupPath, 'utf-8')).toBe(file);
  });

  it('the migrated block is managed, so the NEXT bump needs no human at all', async () => {
    const body = `${policyMarkerLine(PREVIOUS)}\n\nOld.\n\n${MINE_A}`;
    await writeFile(
      join(claudeHomeDir, 'CLAUDE.md'),
      `${GLOBAL_KR_START}\n${body}\n${GLOBAL_KR_END}\n`,
    );

    const [global] = await detectPolicyDrift();
    await migrateBlock(global);

    const after = await readFile(join(claudeHomeDir, 'CLAUDE.md'), 'utf-8');
    const between = after.split(GLOBAL_KR_START)[1].split(GLOBAL_KR_END)[0];
    expect(hasManagedRegions(between)).toBe(true);
    // Re-detecting finds nothing to do: the freeze is over, not deferred.
    expect(needsAttention(await detectPolicyDrift())).toEqual([]);
  });

  it('project: same guarantee on the project surface', async () => {
    const body = `${policyMarkerLine(PREVIOUS)}\n\nOld project policy.\n\n${MINE_B}`;
    await writeFile(
      join(projectDir, 'CLAUDE.md'),
      `${PROJECT_VALIS_START}\n${body}\n${PROJECT_VALIS_END}\n\n# Notes\n`,
    );

    const drifts = await detectPolicyDrift(projectDir);
    await migrateBlock(drifts.find((d) => d.surface === 'project')!);

    const after = await readFile(join(projectDir, 'CLAUDE.md'), 'utf-8');
    expect(after.split(CUSTOM_REGION_START)[1].split(CUSTOM_REGION_END)[0]).toContain(MINE_B);
    expect(after).toContain('### Auto-store triggers');
    expect(after).toContain('# Notes');
  });

  it('a block with no additions still migrates — it is stale, not customized', async () => {
    const body = `${policyMarkerLine(PREVIOUS)}\n${GLOBAL_KR_BODY}`;
    await writeFile(
      join(claudeHomeDir, 'CLAUDE.md'),
      `${GLOBAL_KR_START}\n${body}\n${GLOBAL_KR_END}\n`,
    );
    const [global] = await detectPolicyDrift();
    expect(global.additions).toEqual([]);
    await migrateBlock(global);
    expect(await readFile(join(claudeHomeDir, 'CLAUDE.md'), 'utf-8')).toContain(
      `valis:policy-version:${KR_POLICY_VERSION}`,
    );
  });

  it('migration is idempotent — running it twice does not stack regions', async () => {
    await injectClaudeMdMarkers(projectDir);
    const once = await readFile(join(projectDir, 'CLAUDE.md'), 'utf-8');
    // Already managed → detection reports nothing, so nothing runs twice.
    const drifts = await detectPolicyDrift(projectDir);
    expect(needsAttention(drifts)).toEqual([]);
    await injectClaudeMdMarkers(projectDir);
    const twice = await readFile(join(projectDir, 'CLAUDE.md'), 'utf-8');
    expect(twice).toBe(once);
    expect(twice.split(CUSTOM_REGION_START)).toHaveLength(2);
  });

  it('the canonical project body is what migration writes, not a paraphrase', async () => {
    const body = `${policyMarkerLine(PREVIOUS)}\n\nOld.\n\n${MINE_A}`;
    await writeFile(
      join(projectDir, 'CLAUDE.md'),
      `${PROJECT_VALIS_START}\n${body}\n${PROJECT_VALIS_END}\n`,
    );
    const drifts = await detectPolicyDrift(projectDir);
    await migrateBlock(drifts.find((d) => d.surface === 'project')!);
    const after = await readFile(join(projectDir, 'CLAUDE.md'), 'utf-8');
    expect(after).toContain(AGENT_INSTRUCTIONS.split('\n').slice(-1)[0]);
  });
});

/**
 * The notice. gh#340's actual damage was not that the block went stale — it was
 * that nothing said so across 1,904 sessions. A notice that prints every
 * session would be tuned out just as completely, so the throttle is part of the
 * fix, not a nicety, and both halves are asserted.
 */
describe('gh#340 A — the notice breaks the silence without becoming noise', () => {
  let claudeHomeDir: string;
  let projectDir: string;
  let valisHomeDir: string;
  let prevClaudeHome: string | undefined;
  let prevValisHome: string | undefined;
  let written: string[];
  let restoreWrite: () => void;

  beforeEach(async () => {
    claudeHomeDir = await mkdtemp(join(tmpdir(), 'valis-note-claude-'));
    projectDir = await mkdtemp(join(tmpdir(), 'valis-note-proj-'));
    valisHomeDir = await mkdtemp(join(tmpdir(), 'valis-note-home-'));
    prevClaudeHome = process.env.CLAUDE_CONFIG_HOME;
    prevValisHome = process.env.VALIS_HOME;
    process.env.CLAUDE_CONFIG_HOME = claudeHomeDir;
    process.env.VALIS_HOME = valisHomeDir;

    written = [];
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      written.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    restoreWrite = () => {
      process.stderr.write = original;
    };
  });

  afterEach(async () => {
    restoreWrite();
    if (prevClaudeHome === undefined) delete process.env.CLAUDE_CONFIG_HOME;
    else process.env.CLAUDE_CONFIG_HOME = prevClaudeHome;
    if (prevValisHome === undefined) delete process.env.VALIS_HOME;
    else process.env.VALIS_HOME = prevValisHome;
    for (const d of [claudeHomeDir, projectDir, valisHomeDir]) {
      await rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it('a frozen block is announced once, then held for 24h', async () => {
    const body = `${policyMarkerLine(PREVIOUS)}\n\nOld.\n\n${MINE_A}`;
    await writeFile(
      join(claudeHomeDir, 'CLAUDE.md'),
      `${GLOBAL_KR_START}\n${body}\n${GLOBAL_KR_END}\n`,
    );

    await maybeNoticePolicyDrift(projectDir);
    expect(written.join('')).toMatch(/policy generation behind/);
    expect(written.join('')).toMatch(/valis doctor/);

    written.length = 0;
    await maybeNoticePolicyDrift(projectDir);
    expect(written.join('')).toBe('');
  });

  it('a healthy install says nothing at all', async () => {
    await writeFile(join(claudeHomeDir, 'CLAUDE.md'), `${canonicalGlobalKrBlock()}\n`);
    await maybeNoticePolicyDrift(projectDir);
    expect(written.join('')).toBe('');
  });
});

/**
 * gh#340 A review round 1 — the five ways this could have hurt someone.
 * Every case here writes nothing, or writes without losing a byte.
 */
describe('gh#340 A — migration cannot lose text', () => {
  let claudeHomeDir: string;
  let projectDir: string;
  let valisHomeDir: string;
  let prevClaudeHome: string | undefined;
  let prevValisHome: string | undefined;

  beforeEach(async () => {
    claudeHomeDir = await mkdtemp(join(tmpdir(), 'valis-loss-claude-'));
    projectDir = await mkdtemp(join(tmpdir(), 'valis-loss-proj-'));
    valisHomeDir = await mkdtemp(join(tmpdir(), 'valis-loss-home-'));
    prevClaudeHome = process.env.CLAUDE_CONFIG_HOME;
    prevValisHome = process.env.VALIS_HOME;
    process.env.CLAUDE_CONFIG_HOME = claudeHomeDir;
    process.env.VALIS_HOME = valisHomeDir;
  });

  afterEach(async () => {
    if (prevClaudeHome === undefined) delete process.env.CLAUDE_CONFIG_HOME;
    else process.env.CLAUDE_CONFIG_HOME = prevClaudeHome;
    if (prevValisHome === undefined) delete process.env.VALIS_HOME;
    else process.env.VALIS_HOME = prevValisHome;
    for (const d of [claudeHomeDir, projectDir, valisHomeDir]) {
      await rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it('the whole previous body survives — blank lines, indentation, quoted markers', async () => {
    // Each of these is a line the additions heuristic would have dropped:
    // a blank line, an indented code line, a line quoting a Valis marker, and
    // a line the user wrote that happens to match canonical text exactly.
    const canonicalLine = GLOBAL_KR_BODY.split('\n').find((l) => l.trim().length > 20)!.trim();
    const body = [
      policyMarkerLine(PREVIOUS),
      '',
      'Old policy text.',
      '',
      MINE_A,
      '',
      '    indented code line',
      `I document <!-- valis:policy-version:x --> in my notes.`,
      canonicalLine,
    ].join('\n');
    await writeFile(
      join(claudeHomeDir, 'CLAUDE.md'),
      `${GLOBAL_KR_START}\n${body}\n${GLOBAL_KR_END}\n`,
    );

    const [global] = await detectPolicyDrift();
    await migrateBlock(global);

    const after = await readFile(join(claudeHomeDir, 'CLAUDE.md'), 'utf-8');
    const custom = after.split(CUSTOM_REGION_START)[1].split(CUSTOM_REGION_END)[0];
    // Verbatim: the entire old body is present as one contiguous string.
    expect(custom).toContain(body);
    expect(custom).toContain('    indented code line');
    expect(custom).toContain(canonicalLine);
    // And the new policy landed alongside it.
    expect(after).toContain(`valis:policy-version:${KR_POLICY_VERSION}`);
  });

  it('a file edited while the prompt was open is refused, not overwritten', async () => {
    const body = `${policyMarkerLine(PREVIOUS)}\n\nOld.\n\n${MINE_A}`;
    await writeFile(
      join(claudeHomeDir, 'CLAUDE.md'),
      `${GLOBAL_KR_START}\n${body}\n${GLOBAL_KR_END}\n`,
    );
    const [stale] = await detectPolicyDrift();

    // The user migrates in another window while this one waits at the prompt.
    await writeFile(join(claudeHomeDir, 'CLAUDE.md'), `${canonicalGlobalKrBlock()}\n`);
    const before = await readFile(join(claudeHomeDir, 'CLAUDE.md'), 'utf-8');

    await expect(migrateBlock(stale)).rejects.toThrow(/changed since it was inspected/);
    expect(await readFile(join(claudeHomeDir, 'CLAUDE.md'), 'utf-8')).toBe(before);
  });

  it('a block from a newer CLI is reported but never migrated', async () => {
    const body = `${policyMarkerLine('2099-01-01-from-the-future')}\n\nSomething newer.`;
    await writeFile(
      join(claudeHomeDir, 'CLAUDE.md'),
      `${GLOBAL_KR_START}\n${body}\n${GLOBAL_KR_END}\n`,
    );
    const drifts = await detectPolicyDrift();
    expect(drifts[0].state).toBe('newer');
    expect(needsAttention(drifts)).toHaveLength(1);
    expect(migratable(drifts)).toEqual([]);
  });

  it('a malformed block is reported but never migrated', async () => {
    await writeFile(
      join(claudeHomeDir, 'CLAUDE.md'),
      `${canonicalGlobalKrBlock()}\n\nI quote ${GLOBAL_KR_END} here.\n`,
    );
    const drifts = await detectPolicyDrift();
    expect(migratable(drifts)).toEqual([]);
  });

  it('no temp file is left behind by an atomic write', async () => {
    const body = `${policyMarkerLine(PREVIOUS)}\n\nOld.\n\n${MINE_A}`;
    await writeFile(
      join(claudeHomeDir, 'CLAUDE.md'),
      `${GLOBAL_KR_START}\n${body}\n${GLOBAL_KR_END}\n`,
    );
    const [global] = await detectPolicyDrift();
    await migrateBlock(global);
    const { readdir } = await import('node:fs/promises');
    expect((await readdir(claudeHomeDir)).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('the global block is noticed even with no Valis project in sight', async () => {
    const body = `${policyMarkerLine(PREVIOUS)}\n\nOld.\n\n${MINE_A}`;
    await writeFile(
      join(claudeHomeDir, 'CLAUDE.md'),
      `${GLOBAL_KR_START}\n${body}\n${GLOBAL_KR_END}\n`,
    );
    // No projectDir at all — the case a project-gated check would miss forever.
    const drifts = await detectPolicyDrift(undefined);
    expect(needsAttention(drifts)).toHaveLength(1);
    expect(drifts[0].surface).toBe('global');
  });
});

describe('gh#340 A — review round 2: the two ways verbatim could still lose everything', () => {
  let claudeHomeDir: string;
  let valisHomeDir: string;
  let prevClaudeHome: string | undefined;
  let prevValisHome: string | undefined;

  beforeEach(async () => {
    claudeHomeDir = await mkdtemp(join(tmpdir(), 'valis-r2-claude-'));
    valisHomeDir = await mkdtemp(join(tmpdir(), 'valis-r2-home-'));
    prevClaudeHome = process.env.CLAUDE_CONFIG_HOME;
    prevValisHome = process.env.VALIS_HOME;
    process.env.CLAUDE_CONFIG_HOME = claudeHomeDir;
    process.env.VALIS_HOME = valisHomeDir;
  });

  afterEach(async () => {
    if (prevClaudeHome === undefined) delete process.env.CLAUDE_CONFIG_HOME;
    else process.env.CLAUDE_CONFIG_HOME = prevClaudeHome;
    if (prevValisHome === undefined) delete process.env.VALIS_HOME;
    else process.env.VALIS_HOME = prevValisHome;
    for (const d of [claudeHomeDir, valisHomeDir]) {
      await rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it('an old body that documents a REGION marker is refused, not silently emptied', async () => {
    // The realistic case: a CLAUDE.md that explains Valis's own markers. Placing
    // it inside the carrier gives that marker two occurrences, the exactly-once
    // validation fails, and the composer would substitute the placeholder —
    // losing the entire previous body under a "nothing is dropped" prompt.
    const body = [
      policyMarkerLine(PREVIOUS),
      '',
      'My notes explain the split:',
      CUSTOM_REGION_START,
      MINE_A,
    ].join('\n');
    const file = `${GLOBAL_KR_START}\n${body}\n${GLOBAL_KR_END}\n`;
    await writeFile(join(claudeHomeDir, 'CLAUDE.md'), file);

    const [global] = await detectPolicyDrift();
    await expect(migrateBlock(global)).rejects.toThrow(/region marker/);
    // Byte-identical: refusing means refusing, not half-writing.
    expect(await readFile(join(claudeHomeDir, 'CLAUDE.md'), 'utf-8')).toBe(file);
  });

  it('a byte-level change between inspection and write is caught, even if still frozen', async () => {
    // The narrow race the state check alone cannot see: the file changes A→B,
    // both frozen. Writing a block built from A would delete whatever B added.
    const bodyA = `${policyMarkerLine(PREVIOUS)}\n\nOld.\n\n${MINE_A}`;
    const path = join(claudeHomeDir, 'CLAUDE.md');
    await writeFile(path, `${GLOBAL_KR_START}\n${bodyA}\n${GLOBAL_KR_END}\n`);
    const [stale] = await detectPolicyDrift();

    const bodyB = `${bodyA}\n${MINE_B}`;
    const fileB = `${GLOBAL_KR_START}\n${bodyB}\n${GLOBAL_KR_END}\n`;
    await writeFile(path, fileB);

    // Still `frozen`, so only a byte comparison can catch it. Migration must
    // either refuse, or carry B's new line — never drop it.
    const after = await migrateBlock(stale)
      .then(() => readFile(path, 'utf-8'))
      .catch(() => readFile(path, 'utf-8'));
    expect(after).toContain(MINE_B);
  });
});
