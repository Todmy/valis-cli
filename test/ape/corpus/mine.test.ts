/**
 * 285/RT3: JSONL prompt miner reshaped to multi-step sequences — ape/corpus/mine.ts.
 *
 * mineScenarios({ projectsDir, mix }) walks `*\/*.jsonl` under projectsDir and
 * extracts multi-turn user-prompt SEQUENCES — consecutive typed prompts within a
 * single session, up to length L — honouring the `mix` length-bucket targets.
 * Reuses ClaudeCodeAdapter.parseLog (Task 3) to separate a real prompt from a
 * tool_result echo and a hook-injected `<valis_search_results>` block.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mineScenarios, isJunkPrompt } from '../../../src/ape/corpus/mine.js';

/** Build one JSONL line from an object. */
const j = (o: unknown) => JSON.stringify(o);

const userPrompt = (text: string, sessionId: string) =>
  j({ type: 'user', sessionId, message: { role: 'user', content: text } });

/** A tool-result echo: type:user with an array content of tool_result parts. */
const toolResultEcho = (sessionId: string) =>
  j({
    type: 'user',
    sessionId,
    message: {
      role: 'user',
      content: [{ tool_use_id: 't1', type: 'tool_result', content: 'ok', is_error: false }],
    },
  });

let projectsDir: string;

beforeAll(() => {
  projectsDir = mkdtempSync(join(tmpdir(), 'ape-mine-'));

  // project-a/session-1.jsonl — a clean run of 3 consecutive typed prompts,
  // interleaved with a tool_result echo that must NOT break the sequence count
  // nor appear in any turn text.
  const a = join(projectsDir, 'project-a');
  mkdirSync(a, { recursive: true });
  writeFileSync(
    join(a, 'session-1.jsonl'),
    [
      userPrompt('start the PRD', 's-a'),
      toolResultEcho('s-a'),
      userPrompt('now implement step one', 's-a'),
      userPrompt('and write the migration', 's-a'),
    ].join('\n'),
  );

  // project-b/session-2.jsonl — prompts with an injected block in the middle.
  const b = join(projectsDir, 'project-b');
  mkdirSync(b, { recursive: true });
  writeFileSync(
    join(b, 'session-2.jsonl'),
    [
      userPrompt('how did we decide on auth?', 's-b'),
      userPrompt(
        'investigate the bug\n<valis_search_results count="1">\n<hit id="d1">a decision</hit>\n</valis_search_results>',
        's-b',
      ),
      userPrompt('write the rollback plan', 's-b'),
    ].join('\n'),
  );
});

afterAll(() => {
  rmSync(projectsDir, { recursive: true, force: true });
});

describe('mineScenarios', () => {
  it('extracts a 3-turn sequence', () => {
    const scenarios = mineScenarios({ projectsDir, mix: { 3: 1 } });
    const three = scenarios.find((s) => s.turns.length === 3);
    expect(three).toBeDefined();
    expect(three!.turns).toEqual([
      'start the PRD',
      'now implement step one',
      'and write the migration',
    ]);
    // provenance carried through.
    expect(three!.sourceSession).toBe('s-a');
  });

  it('respects mix counts', () => {
    // Two sessions each yield several 1-turn windows; cap the 1-bucket at 2.
    const scenarios = mineScenarios({ projectsDir, mix: { 1: 2 } });
    expect(scenarios).toHaveLength(2);
    expect(scenarios.every((s) => s.turns.length === 1)).toBe(true);
  });

  it('excludes tool_result + injection text', () => {
    const scenarios = mineScenarios({ projectsDir, mix: { 1: 10, 2: 10, 3: 10 } });
    const allTurns = scenarios.flatMap((s) => s.turns);
    // The injected block and the tool_result echo must never appear in any turn.
    expect(allTurns.some((t) => t.includes('<valis_search_results'))).toBe(false);
    expect(allTurns.some((t) => t.includes('investigate the bug'))).toBe(false);
    expect(allTurns.some((t) => t.includes('tool_result'))).toBe(false);
    expect(allTurns.every((t) => t.trim().length > 0)).toBe(true);
  });

  it('1-turn bucket = single prompt', () => {
    const scenarios = mineScenarios({ projectsDir, mix: { 1: 1 } });
    expect(scenarios).toHaveLength(1);
    expect(scenarios[0].turns).toHaveLength(1);
    // first typed prompt of the first (sorted) session.
    expect(scenarios[0].turns[0]).toBe('start the PRD');
  });
});

// RT18 (F6): project/recency filtering + harness-wrapper drop.
describe('mineScenarios RT18 filters', () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'ape-mine-rt18-'));

    // a valis-named project + an unrelated one.
    const valis = join(dir, 'home-me-github-valis');
    mkdirSync(valis, { recursive: true });
    writeFileSync(
      join(valis, 'sv.jsonl'),
      [userPrompt('valis: design the recall gate', 'sv')].join('\n'),
    );
    const other = join(dir, 'home-me-Downloads-personal');
    mkdirSync(other, { recursive: true });
    writeFileSync(
      join(other, 'so.jsonl'),
      [userPrompt('analyse my MRI scan in this folder', 'so')].join('\n'),
    );

    // a junk-laden session in the valis project.
    writeFileSync(
      join(valis, 'sj.jsonl'),
      [
        userPrompt('<local-command-caveat>Caveat: generated by a local command</local-command-caveat>', 'sj'),
        userPrompt('<task-notification><task-id>abc</task-id></task-notification>', 'sj'),
        userPrompt('Caveat: The messages below were generated', 'sj'),
        userPrompt('/compact', 'sj'),
        userPrompt('X'.repeat(5000), 'sj'),
        userPrompt('real dev prompt: refactor the auth module', 'sj'),
      ].join('\n'),
    );

    // recency: two sessions in a third project; make sr-new newer than sr-old.
    const rec = join(dir, 'home-me-github-valis-rec');
    mkdirSync(rec, { recursive: true });
    const old = join(rec, 'sr-old.jsonl');
    const recent = join(rec, 'sr-new.jsonl');
    writeFileSync(old, [userPrompt('OLD first prompt', 'sr-old')].join('\n'));
    writeFileSync(recent, [userPrompt('NEW first prompt', 'sr-new')].join('\n'));
    utimesSync(old, new Date(1_600_000_000_000 / 1000), new Date(1_600_000_000_000 / 1000));
    utimesSync(recent, new Date(1_700_000_000_000 / 1000), new Date(1_700_000_000_000 / 1000));
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('projectFilter limits sessions to matching projects', () => {
    const scenarios = mineScenarios({ projectsDir: dir, mix: { 1: 50 }, projectFilter: 'valis' });
    const turns = scenarios.flatMap((s) => s.turns);
    expect(turns.some((t) => t.includes('design the recall gate'))).toBe(true);
    // the unrelated personal project is excluded.
    expect(turns.some((t) => t.includes('MRI scan'))).toBe(false);
  });

  it('drops command/caveat/task-notification wrappers, bare slash-command, over-long paste', () => {
    const scenarios = mineScenarios({ projectsDir: dir, mix: { 1: 50 }, projectFilter: 'valis' });
    const turns = scenarios.flatMap((s) => s.turns);
    expect(turns.some((t) => t.startsWith('<local-command'))).toBe(false);
    expect(turns.some((t) => t.startsWith('<task-notification'))).toBe(false);
    expect(turns.some((t) => t.startsWith('Caveat:'))).toBe(false);
    expect(turns).not.toContain('/compact');
    expect(turns.some((t) => t.length > 4000)).toBe(false);
    // the one real prompt in the junk session survives.
    expect(turns.some((t) => t.includes('refactor the auth module'))).toBe(true);
  });

  it('recencyFirst orders sessions by mtime descending', () => {
    const scenarios = mineScenarios({
      projectsDir: dir,
      mix: { 1: 1 },
      projectFilter: 'valis-rec',
      recencyFirst: true,
    });
    expect(scenarios).toHaveLength(1);
    expect(scenarios[0].turns[0]).toBe('NEW first prompt');
  });
});

describe('isJunkPrompt', () => {
  it('flags wrappers and bare slash-commands, keeps real prompts', () => {
    expect(isJunkPrompt('<local-command-caveat>x</local-command-caveat>')).toBe(true);
    expect(isJunkPrompt('/compact')).toBe(true);
    expect(isJunkPrompt('Caveat: generated')).toBe(true);
    expect(isJunkPrompt('X'.repeat(5000))).toBe(true);
    expect(isJunkPrompt('refactor the auth module to use the shared client')).toBe(false);
    // a slash-prefixed prompt with real prose is NOT junk.
    expect(isJunkPrompt('/Users/me/file.md analyse this brief and report findings')).toBe(false);
  });
});
