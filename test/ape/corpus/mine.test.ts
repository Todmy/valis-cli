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
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mineScenarios } from '../../../src/ape/corpus/mine.js';

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
