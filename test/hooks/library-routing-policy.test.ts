/**
 * gh#338 — the agent-instruction policy must route between the decision store
 * and a project's reference library.
 *
 * Both `library_search` and `library_list` are registered unconditionally and
 * carry good descriptions, so an obvious domain question routes on the
 * description alone. What no description can express is a rule that spans two
 * tools — a hybrid question needs both, and an empty `valis_search` is not
 * evidence of absence. Those live in the injected policy block, and this file
 * is the guard that they stay there.
 *
 * The block is written into four surfaces (global CLAUDE.md, project CLAUDE.md,
 * .cursorrules, AGENTS.md) from three separate template strings. A rule that
 * silently exists in only some of them is the same partial coverage the feature
 * exists to prevent, so every surface is asserted, not just the canonical one.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  GLOBAL_KR_BODY,
  GLOBAL_KR_START,
  GLOBAL_KR_END,
  KR_POLICY_VERSION,
  POLICY_VERSION_HISTORY,
  PROJECT_VALIS_START,
  PROJECT_VALIS_END,
  canonicalGlobalKrBlock,
  isOlderPolicy,
  CUSTOM_REGION_START,
  CUSTOM_REGION_END,
  POLICY_REGION_START,
  POLICY_REGION_END,
  hasManagedRegions,
  extractCustomRegion,
  composeManagedBody,
} from '../../src/hooks/self-heal-templates.js';
import { __internal, runSelfHeal } from '../../src/hooks/self-heal.js';
import { injectClaudeMdMarkers } from '../../src/ide/claude-code.js';
import { injectCursorrules } from '../../src/ide/cursor.js';
import { injectAgentsMdMarkers } from '../../src/ide/codex.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function withTempProject(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'valis-gh338-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * The minimum a surface must carry. Deliberately keyed on the tool names and
 * on the two cross-tool rules rather than on prose, so wording can be edited
 * without the guard going quiet — but not removed.
 */
function assertCarriesRouting(text: string, surface: string): void {
  expect(text, `${surface} names library_search`).toContain('library_search');
  expect(text, `${surface} names library_list`).toContain('library_list');
  // Rule 1 — a hybrid question needs both stores.
  expect(text, `${surface} states the both-tools rule`).toMatch(
    /decision AND a\s+citation|both tools|calls both/i,
  );
  // Rule 2 — an empty decision search does not settle the question.
  expect(text, `${surface} states that empty is not absence`).toMatch(
    /nothing on this|not evidence\s+of absence/i,
  );
  // Rule 3 — what may be quoted.
  expect(text, `${surface} names the citable field`).toContain('chunk_text');
  expect(text, `${surface} warns off the ingest-written field`).toContain('contextual_text');
  // Reading another project's shelf needs the UUID; nothing infers it.
  expect(text, `${surface} names target_project_id`).toContain('target_project_id');
  // The honest half: most projects have no corpus, and saying so is not a fault.
  expect(text, `${surface} allows for projects with no library`).toContain('has_library: false');
}

describe('gh#338 — reference-library routing reaches every instruction surface', () => {
  it('global CLAUDE.md canonical body carries the rules', () => {
    assertCarriesRouting(GLOBAL_KR_BODY, 'GLOBAL_KR_BODY');
  });

  it('project CLAUDE.md block carries the rules', async () => {
    await withTempProject(async (dir) => {
      await injectClaudeMdMarkers(dir);
      const md = await readFile(join(dir, 'CLAUDE.md'), 'utf-8');
      const between = md.split(PROJECT_VALIS_START)[1].split(PROJECT_VALIS_END)[0];
      assertCarriesRouting(between, 'project CLAUDE.md');
    });
  });

  it('.cursorrules block carries the rules', async () => {
    await withTempProject(async (dir) => {
      await injectCursorrules(dir);
      assertCarriesRouting(await readFile(join(dir, '.cursorrules'), 'utf-8'), '.cursorrules');
    });
  });

  it('AGENTS.md block carries the rules', async () => {
    await withTempProject(async (dir) => {
      await injectAgentsMdMarkers(dir);
      assertCarriesRouting(await readFile(join(dir, 'AGENTS.md'), 'utf-8'), 'AGENTS.md');
    });
  });
});

describe('gh#338 — valis_search stops claiming absence it cannot know', () => {
  const SERVER_SRC = readFileSync(resolve(__dirname, '../../src/mcp/server.ts'), 'utf8');

  it('the description says an empty result is not evidence of absence', () => {
    const idx = SERVER_SRC.indexOf('valis_search: {');
    expect(idx).toBeGreaterThan(-1);
    const tail = SERVER_SRC.slice(idx);
    const desc = tail.match(/description:\s*(["'`])([\s\S]*?)\1/)![2];
    expect(desc).toMatch(/not by itself evidence|not evidence of absence/i);
    // It must point at the tool that CAN answer the question, or the caller is
    // told a search is inconclusive with nowhere to go next.
    expect(desc).toContain('library_list');
    // …and at the tool that searches it. Naming only the lister leaves a client
    // able to see the shelf exists and never read from it.
    expect(desc).toContain('library_search');
  });
});

describe('gh#338 — an install on the superseded policy actually upgrades', () => {
  // The failure this guards is specific and silent: bumping KR_POLICY_VERSION
  // while recording a hash that does not match what users actually have on
  // disk. Every existing install then fails the historical-match check and is
  // classified `user_customized` — the block is left alone, the rule never
  // arrives, and nothing reports that it didn't.
  //
  // Asserting "the recorded hash is not the current one" cannot catch that: any
  // two wrong strings pass it. The only honest check is against the real
  // superseded bodies, so they are committed as fixtures — rendered from the
  // 2026-05-19 templates before this change, exactly as self-heal reads them.
  // Named from the version history rather than hard-coded, so the next bump
  // inherits the same guard instead of leaving this file pinned to May 2026.
  const PREVIOUS = POLICY_VERSION_HISTORY[POLICY_VERSION_HISTORY.length - 2];
  const fixture = (surface: 'global' | 'project') =>
    readFileSync(resolve(__dirname, '../fixtures/policy', `policy-${PREVIOUS}-${surface}.txt`), 'utf8');

  let tempHome: string;
  let claudeHomeDir: string;
  let projectDir: string;
  let prevValisHome: string | undefined;
  let prevClaudeHome: string | undefined;

  beforeEach(async () => {
    tempHome = await mkdtemp(join(tmpdir(), 'valis-gh338-home-'));
    claudeHomeDir = await mkdtemp(join(tmpdir(), 'valis-gh338-claude-'));
    projectDir = await mkdtemp(join(tmpdir(), 'valis-gh338-proj-'));
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
    for (const d of [tempHome, claudeHomeDir, projectDir]) {
      await rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it('the superseded global body is the one recorded as historical', () => {
    expect(__internal.HISTORICAL_GLOBAL_KR_HASHES).toContain(
      __internal.contentHash(fixture('global')),
    );
  });

  it('the superseded project body is the one recorded as historical', () => {
    expect(__internal.HISTORICAL_AGENT_INSTRUCTIONS_HASHES).toContain(
      __internal.contentHash(fixture('project')),
    );
  });

  it('self-heal upgrades a global CLAUDE.md sitting on the superseded policy', async () => {
    const old = `${GLOBAL_KR_START}\n${fixture('global')}\n${GLOBAL_KR_END}`;
    await writeFile(join(claudeHomeDir, 'CLAUDE.md'), `# Mine\n\n${old}\n`);

    const reports = await runSelfHeal({ projectDir, silent: true });
    const r = reports.find((x) => x.target.includes('Knowledge Retention'));
    expect(r?.outcome).toBe('repaired');
    expect(r?.notes ?? '').toMatch(/auto-upgrade/);

    const after = await readFile(join(claudeHomeDir, 'CLAUDE.md'), 'utf-8');
    expect(after).toContain('library_search');
    expect(after).toContain(KR_POLICY_VERSION);
    expect(after).toContain('# Mine');
  });

  it('self-heal upgrades a project CLAUDE.md sitting on the superseded policy', async () => {
    const old = `${PROJECT_VALIS_START}\n${fixture('project')}\n${PROJECT_VALIS_END}`;
    await writeFile(join(projectDir, 'CLAUDE.md'), `${old}\n\n# Project notes\n`);

    const reports = await runSelfHeal({ projectDir, silent: true });
    const r = reports.find((x) => x.target.includes('valis:start markers'));
    expect(r?.outcome).toBe('repaired');
    expect(r?.notes ?? '').toMatch(/auto-upgrade/);

    const after = await readFile(join(projectDir, 'CLAUDE.md'), 'utf-8');
    expect(after).toContain('library_search');
    expect(after).toContain(KR_POLICY_VERSION);
    expect(after).toContain('# Project notes');
  });

  it('the policy version advanced past the one it supersedes', () => {
    // Order is position in POLICY_VERSION_HISTORY, NOT lex order — the two
    // disagree as of gh#340 ('…managed-policy-region' sorts BEFORE
    // '…reference-library-routing' despite shipping after it), and a lex
    // comparison would read that upgrade as a downgrade and strand every
    // install on the previous generation.
    expect(isOlderPolicy(PREVIOUS)).toBe(true);
    expect(isOlderPolicy(KR_POLICY_VERSION)).toBe(false);
    expect(KR_POLICY_VERSION).toBe(POLICY_VERSION_HISTORY[POLICY_VERSION_HISTORY.length - 1]);
  });

  // The forcing function. A future bump appends to POLICY_VERSION_HISTORY —
  // that is the only way to change KR_POLICY_VERSION — and this coupling then
  // demands the matching body hash, so "bumped the policy, forgot the hashes"
  // fails here instead of silently stranding every install on the old block.
  // Closing the other half of the same hole (gh#338 review round 3). Length
  // coupling forces an APPEND to be paid for, but not the case where a bump
  // REPLACES the last entry: lengths stay equal, `PREVIOUS` still points at
  // May, and the generation that actually shipped in between leaves no trace.
  //
  // The fix is to record what shipped outside the array. Every generation from
  // the fixture era onward — including the current one — has its bodies
  // committed here, so replacing the last entry leaves an orphan fixture on
  // disk and a missing one for the new slug. Both sides are asserted.
  it('the fixture set on disk is exactly the versions the history claims shipped', () => {
    // The two pre-marker generations predate fixtures; their hashes were
    // recorded retroactively and their bodies are not recoverable.
    const legacy = new Set(['pre-0.5.4', '0.5.4-mirror-write']);
    const expected = POLICY_VERSION_HISTORY.filter((v) => !legacy.has(v)).sort();
    // Both surfaces are inventoried. A generation present as `-global` but
    // missing as `-project` would otherwise pass, and the next bump would then
    // record a hash for a project body nobody ever had.
    for (const surface of ['global', 'project'] as const) {
      const onDisk = readdirSync(resolve(__dirname, '../fixtures/policy'))
        .filter((f) => f.endsWith(`-${surface}.txt`))
        .map((f) => f.replace(/^policy-/, '').replace(new RegExp(`-${surface}\\.txt$`), ''))
        .sort();
      expect(onDisk, `${surface} fixtures`).toEqual(expected);
    }
  });

  it('the current fixtures are the bodies actually shipping, not stale copies', async () => {
    // Also catches the inverse mistake: editing a template without re-rendering
    // the fixture, which would make the next bump record a body nobody had.
    const current = (surface: 'global' | 'project') =>
      readFileSync(
        resolve(__dirname, '../fixtures/policy', `policy-${KR_POLICY_VERSION}-${surface}.txt`),
        'utf8',
      );
    // Compared against the composed block (policy region + custom region), not
    // the bare policy body — the fixture records what actually lands between
    // the markers on disk, which is what a future bump will hash.
    const shippedGlobal = canonicalGlobalKrBlock()
      .split(GLOBAL_KR_START)[1]
      .split(GLOBAL_KR_END)[0];
    expect(__internal.contentHash(current('global'))).toBe(
      __internal.contentHash(shippedGlobal),
    );

    await withTempProject(async (dir) => {
      await injectClaudeMdMarkers(dir);
      const md = await readFile(join(dir, 'CLAUDE.md'), 'utf-8');
      const between = md.split(PROJECT_VALIS_START)[1].split(PROJECT_VALIS_END)[0];
      expect(__internal.contentHash(current('project'))).toBe(__internal.contentHash(between));
    });
  });

  it('every superseded generation has its body hash recorded, on both surfaces', () => {
    const superseded = POLICY_VERSION_HISTORY.length - 1;
    expect(__internal.HISTORICAL_GLOBAL_KR_HASHES).toHaveLength(superseded);
    expect(__internal.HISTORICAL_AGENT_INSTRUCTIONS_HASHES).toHaveLength(superseded);
    for (const list of [
      __internal.HISTORICAL_GLOBAL_KR_HASHES,
      __internal.HISTORICAL_AGENT_INSTRUCTIONS_HASHES,
    ]) {
      expect(new Set(list).size, 'a duplicate means one bump was recorded twice').toBe(list.length);
    }
  });
});

/**
 * gh#340 (option C) — the injected block is split into a policy region Valis
 * owns and a custom region it never reads. The defect this closes: before the
 * split, ANY edit inside the block changed its body hash, the historical-hash
 * gate then classified the install `user_customized`, and every later policy
 * bump silently skipped it. The author's own machine sat four generations
 * behind for that reason.
 */
describe('gh#340 — a customized block still receives policy upgrades', () => {
  const PREVIOUS = POLICY_VERSION_HISTORY[POLICY_VERSION_HISTORY.length - 2];
  const MINE = 'Always greet me in Ukrainian before answering.';

  /** The current block, rolled back to the previous version marker. */
  function managedBlockOnOldPolicy(block: string, custom: string): string {
    return block
      .replace(
        `<!-- valis:policy-version:${KR_POLICY_VERSION} -->`,
        `<!-- valis:policy-version:${PREVIOUS} -->`,
      )
      .replace(
        new RegExp(
          `${CUSTOM_REGION_START.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${CUSTOM_REGION_END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`,
        ),
        `${CUSTOM_REGION_START}\n${custom}\n${CUSTOM_REGION_END}`,
      );
  }

  let claudeHomeDir: string;
  let tempHome: string;
  let projectDir: string;
  let prevValisHome: string | undefined;
  let prevClaudeHome: string | undefined;

  beforeEach(async () => {
    tempHome = await mkdtemp(join(tmpdir(), 'valis-gh340-home-'));
    claudeHomeDir = await mkdtemp(join(tmpdir(), 'valis-gh340-claude-'));
    projectDir = await mkdtemp(join(tmpdir(), 'valis-gh340-proj-'));
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
    for (const d of [tempHome, claudeHomeDir, projectDir]) {
      await rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it('the freshly written block carries both regions and the version marker', () => {
    const block = canonicalGlobalKrBlock();
    expect(block).toContain(POLICY_REGION_START);
    expect(block).toContain(POLICY_REGION_END);
    expect(block).toContain(CUSTOM_REGION_START);
    expect(block).toContain(CUSTOM_REGION_END);
    // The marker sits INSIDE the policy region — reading it from the custom
    // region would let a user's stray paste dictate the upgrade decision.
    const policy = block.split(POLICY_REGION_START)[1].split(POLICY_REGION_END)[0];
    expect(policy).toContain(`valis:policy-version:${KR_POLICY_VERSION}`);
  });

  it('global: an older managed block upgrades AND keeps the custom region verbatim', async () => {
    const old = managedBlockOnOldPolicy(canonicalGlobalKrBlock(), MINE);
    await writeFile(join(claudeHomeDir, 'CLAUDE.md'), `# Mine\n\n${old}\n`);

    const reports = await runSelfHeal({ projectDir, silent: true });
    const r = reports.find((x) => x.target.includes('Knowledge Retention'));
    expect(r?.outcome).toBe('repaired');
    expect(r?.notes ?? '').toMatch(/custom region preserved/);

    const after = await readFile(join(claudeHomeDir, 'CLAUDE.md'), 'utf-8');
    expect(after).toContain(`valis:policy-version:${KR_POLICY_VERSION}`);
    expect(after).toContain(MINE);
    expect(after).toContain('# Mine');
  });

  it('global: an EDITED policy region is rewritten, not frozen as user_customized', async () => {
    // The exact case that froze the author's machine. Under the legacy hash
    // gate this body matched nothing historical → `user_customized` → frozen.
    const edited = managedBlockOnOldPolicy(canonicalGlobalKrBlock(), MINE).replace(
      'Two-layer model:',
      'Two-layer model (I rewrote this line):',
    );
    await writeFile(join(claudeHomeDir, 'CLAUDE.md'), `${edited}\n`);

    const reports = await runSelfHeal({ projectDir, silent: true });
    const r = reports.find((x) => x.target.includes('Knowledge Retention'));
    expect(r?.outcome).toBe('repaired');

    const after = await readFile(join(claudeHomeDir, 'CLAUDE.md'), 'utf-8');
    expect(after).not.toContain('I rewrote this line');
    expect(after).toContain(MINE); // their edit inside the policy region is lost by design…
  });

  it('global: a current-version managed block with custom text is left alone', async () => {
    const block = canonicalGlobalKrBlock().replace(
      new RegExp(
        `${CUSTOM_REGION_START.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${CUSTOM_REGION_END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`,
      ),
      `${CUSTOM_REGION_START}\n${MINE}\n${CUSTOM_REGION_END}`,
    );
    await writeFile(join(claudeHomeDir, 'CLAUDE.md'), `${block}\n`);

    const reports = await runSelfHeal({ projectDir, silent: true });
    const r = reports.find((x) => x.target.includes('Knowledge Retention'));
    // Body differs from canonical, but the difference is theirs and the policy
    // is current — reporting drift here would be crying wolf every session.
    expect(r?.outcome).toBe('fresh');
    expect(await readFile(join(claudeHomeDir, 'CLAUDE.md'), 'utf-8')).toContain(MINE);
  });

  it('project: an older managed block upgrades AND keeps the custom region verbatim', async () => {
    await injectClaudeMdMarkers(projectDir);
    const fresh = await readFile(join(projectDir, 'CLAUDE.md'), 'utf-8');
    const old = managedBlockOnOldPolicy(fresh, MINE);
    await writeFile(join(projectDir, 'CLAUDE.md'), old);

    const reports = await runSelfHeal({ projectDir, silent: true });
    const r = reports.find((x) => x.target.includes('valis:start markers'));
    expect(r?.outcome).toBe('repaired');
    expect(r?.notes ?? '').toMatch(/custom region preserved/);

    const after = await readFile(join(projectDir, 'CLAUDE.md'), 'utf-8');
    expect(after).toContain(`valis:policy-version:${KR_POLICY_VERSION}`);
    expect(after).toContain(MINE);
  });

  it('a legacy block edited by hand is still left alone — C fixes the future, not the past', async () => {
    // Honest scope statement. Blocks already customized in place carry no
    // regions, so they stay `user_customized` and still need gh#340's
    // reporting half. This test exists so that limit is recorded, not assumed.
    const legacy = `${GLOBAL_KR_START}\n${GLOBAL_KR_BODY}\n\n${MINE}\n${GLOBAL_KR_END}`;
    await writeFile(join(claudeHomeDir, 'CLAUDE.md'), `${legacy}\n`);

    const reports = await runSelfHeal({ projectDir, silent: true });
    const r = reports.find((x) => x.target.includes('Knowledge Retention'));
    expect(r?.outcome).toBe('user_customized');
    expect(await readFile(join(claudeHomeDir, 'CLAUDE.md'), 'utf-8')).toContain(MINE);
  });
});

/**
 * gh#340 review round 1 — the fail-closed edges. Every case here is a shape
 * where a naive rewrite would silently destroy text the user wrote. The rule
 * throughout: when the block cannot be parsed unambiguously, do nothing and
 * say so. Doing nothing is recoverable; a rewrite that ate half a paragraph
 * is not.
 */
describe('gh#340 — malformed and ambiguous blocks are never rewritten', () => {
  const MINE = 'Always greet me in Ukrainian before answering.';

  let claudeHomeDir: string;
  let tempHome: string;
  let projectDir: string;
  let prevValisHome: string | undefined;
  let prevClaudeHome: string | undefined;

  beforeEach(async () => {
    tempHome = await mkdtemp(join(tmpdir(), 'valis-gh340b-home-'));
    claudeHomeDir = await mkdtemp(join(tmpdir(), 'valis-gh340b-claude-'));
    projectDir = await mkdtemp(join(tmpdir(), 'valis-gh340b-proj-'));
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
    for (const d of [tempHome, claudeHomeDir, projectDir]) {
      await rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it('a block missing its custom markers is not treated as managed', () => {
    const noCustom = [POLICY_REGION_START, 'policy', POLICY_REGION_END, MINE].join('\n');
    expect(hasManagedRegions(noCustom)).toBe(false);
    // …and nothing is carried, so the caller cannot mistake a partial parse for
    // an empty region and write the placeholder over the user's text.
    expect(extractCustomRegion(noCustom)).toBeNull();
  });

  it('a marker quoted inside the custom region makes the block malformed, not managed', () => {
    const quoted = [
      POLICY_REGION_START,
      'policy',
      POLICY_REGION_END,
      CUSTOM_REGION_START,
      `I document the markers here: ${CUSTOM_REGION_END} and continue.`,
      CUSTOM_REGION_END,
    ].join('\n');
    expect(hasManagedRegions(quoted)).toBe(false);
    expect(extractCustomRegion(quoted)).toBeNull();
  });

  it('reversed regions are malformed', () => {
    const reversed = [
      CUSTOM_REGION_START,
      MINE,
      CUSTOM_REGION_END,
      POLICY_REGION_START,
      'policy',
      POLICY_REGION_END,
    ].join('\n');
    expect(hasManagedRegions(reversed)).toBe(false);
  });

  it('custom text is carried byte for byte — indentation and blank lines survive', () => {
    const custom = '    indented code line\n\n\ttab line';
    const block = composeManagedBody('policy', undefined).replace(
      `${CUSTOM_REGION_START}\n${CUSTOM_REGION_END}`,
      `${CUSTOM_REGION_START}\n${CUSTOM_REGION_END}`,
    );
    const withCustom = block.replace(
      /<!-- valis:custom:start -->[\s\S]*?<!-- valis:custom:end -->/,
      `${CUSTOM_REGION_START}\n${custom}\n${CUSTOM_REGION_END}`,
    );
    expect(extractCustomRegion(withCustom)).toBe(custom);
    // And it survives a full recompose, which is what an upgrade does.
    expect(extractCustomRegion(composeManagedBody('new policy', withCustom))).toBe(custom);
  });

  it('an emptied custom region stays empty instead of getting the placeholder back', () => {
    const emptied = composeManagedBody('policy').replace(
      /<!-- valis:custom:start -->[\s\S]*?<!-- valis:custom:end -->/,
      `${CUSTOM_REGION_START}\n${CUSTOM_REGION_END}`,
    );
    expect(extractCustomRegion(emptied)).toBe('');
    expect(composeManagedBody('new policy', emptied)).not.toContain('Your own instructions go here');
  });

  it('a version this build has never heard of is left alone, not downgraded', () => {
    // A newer CLI wrote the file; this older one must not fight it every session.
    expect(isOlderPolicy('2099-01-01-from-the-future')).toBe(false);
    expect(isOlderPolicy(null)).toBe(true);
  });

  it('global: a duplicated outer marker refuses the rewrite and reports why', async () => {
    const block = canonicalGlobalKrBlock();
    // The user quoted the end marker inside their own notes below the block.
    const file = `${block}\n\nSee also ${GLOBAL_KR_END} in the docs.\n`;
    await writeFile(join(claudeHomeDir, 'CLAUDE.md'), file);

    const reports = await runSelfHeal({ projectDir, silent: true });
    const r = reports.find((x) => x.target.includes('Knowledge Retention'));
    expect(r?.outcome).toBe('user_customized');
    expect(r?.notes ?? '').toMatch(/ambiguous markers/);
    expect(await readFile(join(claudeHomeDir, 'CLAUDE.md'), 'utf-8')).toBe(file);
  });

  it('project: a duplicated outer marker leaves the file byte-identical', async () => {
    await injectClaudeMdMarkers(projectDir);
    const fresh = await readFile(join(projectDir, 'CLAUDE.md'), 'utf-8');
    // The stray marker must sit INSIDE the block to be dangerous: the
    // non-greedy replace would then cut the block short there, and everything
    // the user wrote after it would be overwritten by the new block.
    const file = fresh.replace(
      CUSTOM_REGION_START,
      `${CUSTOM_REGION_START}\nI quote ${PROJECT_VALIS_END} in my notes.\nAnd this line must survive.`,
    );
    await writeFile(join(projectDir, 'CLAUDE.md'), file);

    await injectClaudeMdMarkers(projectDir);
    expect(await readFile(join(projectDir, 'CLAUDE.md'), 'utf-8')).toBe(file);
  });
});

/**
 * gh#340 review round 2 — "the policy region is ours" has to mean something
 * NOW, not at the next bump. Three gaps closed here:
 *   · an edit inside a current-version policy region was accepted as `fresh`;
 *   · on the project surface the current-version shortcut ran BEFORE the
 *     four-marker validation, so a malformed block reported `fresh` too;
 *   · a version from a newer build reported `fresh`, hiding the mismatch.
 */
describe('gh#340 — policy drift is repaired at the current version too', () => {
  const MINE = 'Always greet me in Ukrainian before answering.';

  let claudeHomeDir: string;
  let tempHome: string;
  let projectDir: string;
  let prevValisHome: string | undefined;
  let prevClaudeHome: string | undefined;

  beforeEach(async () => {
    tempHome = await mkdtemp(join(tmpdir(), 'valis-gh340c-home-'));
    claudeHomeDir = await mkdtemp(join(tmpdir(), 'valis-gh340c-claude-'));
    projectDir = await mkdtemp(join(tmpdir(), 'valis-gh340c-proj-'));
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
    for (const d of [tempHome, claudeHomeDir, projectDir]) {
      await rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it('global: a deleted rule inside a current-version policy region is restored', async () => {
    const tampered = canonicalGlobalKrBlock().replace('Two-layer model:', '');
    await writeFile(join(claudeHomeDir, 'CLAUDE.md'), `${tampered}\n`);

    const reports = await runSelfHeal({ projectDir, silent: true });
    const r = reports.find((x) => x.target.includes('Knowledge Retention'));
    expect(r?.outcome).toBe('repaired');
    expect(r?.notes ?? '').toMatch(/policy region restored/);
    expect(await readFile(join(claudeHomeDir, 'CLAUDE.md'), 'utf-8')).toContain(
      'Two-layer model:',
    );
  });

  it('project: a deleted rule inside a current-version policy region is restored', async () => {
    await injectClaudeMdMarkers(projectDir);
    const fresh = await readFile(join(projectDir, 'CLAUDE.md'), 'utf-8');
    await writeFile(
      join(projectDir, 'CLAUDE.md'),
      fresh.replace('### Auto-store triggers', ''),
    );

    const reports = await runSelfHeal({ projectDir, silent: true });
    const r = reports.find((x) => x.target.includes('valis:start markers'));
    expect(r?.outcome).toBe('repaired');
    expect(await readFile(join(projectDir, 'CLAUDE.md'), 'utf-8')).toContain(
      '### Auto-store triggers',
    );
  });

  it('project: a malformed block with a CURRENT marker is not waved through as fresh', async () => {
    await injectClaudeMdMarkers(projectDir);
    const fresh = await readFile(join(projectDir, 'CLAUDE.md'), 'utf-8');
    // Custom end marker deleted; version marker untouched and current.
    const broken = fresh.replace(`${CUSTOM_REGION_END}`, MINE);
    await writeFile(join(projectDir, 'CLAUDE.md'), broken);

    const reports = await runSelfHeal({ projectDir, silent: true });
    const r = reports.find((x) => x.target.includes('valis:start markers'));
    expect(r?.outcome).toBe('user_customized');
    // …and nothing was written, so their text is still there.
    expect(await readFile(join(projectDir, 'CLAUDE.md'), 'utf-8')).toContain(MINE);
  });

  it('global: a version from a newer build is reported, not silently accepted', async () => {
    const future = canonicalGlobalKrBlock().replace(
      `valis:policy-version:${KR_POLICY_VERSION}`,
      'valis:policy-version:2099-01-01-from-the-future',
    );
    await writeFile(join(claudeHomeDir, 'CLAUDE.md'), `${future}\n`);

    const reports = await runSelfHeal({ projectDir, silent: true });
    const r = reports.find((x) => x.target.includes('Knowledge Retention'));
    expect(r?.outcome).toBe('user_customized');
    expect(r?.notes ?? '').toMatch(/unknown policy version/);
    expect(await readFile(join(claudeHomeDir, 'CLAUDE.md'), 'utf-8')).toContain('2099-01-01');
  });
});
