/**
 * 285/T006: JSONL prompt miner — ape/corpus/mine.ts.
 *
 * minePrompts({ projectsDir, limit }) walks `*\/*.jsonl` under projectsDir,
 * extracts user-role prompt texts (excluding hook-injected `<valis_search_results>`
 * blocks and tool-result echoes — both surfaced via parseLog), dedups
 * near-identical prompts, and caps the result at `limit`.
 *
 * Reuses ClaudeCodeAdapter.parseLog (Task 3) to separate prompt vs injection.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { minePrompts } from '../../../src/ape/corpus/mine.js';

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

  // project-a/session-1.jsonl — two distinct user prompts + a tool-result echo.
  const a = join(projectsDir, 'project-a');
  mkdirSync(a, { recursive: true });
  writeFileSync(
    join(a, 'session-1.jsonl'),
    [
      userPrompt('how did we decide on auth?', 's-a'),
      toolResultEcho('s-a'),
      userPrompt('refactor the parser module', 's-a'),
    ].join('\n'),
  );

  // project-b/session-2.jsonl — one real prompt + one injected block + a duplicate.
  const b = join(projectsDir, 'project-b');
  mkdirSync(b, { recursive: true });
  writeFileSync(
    join(b, 'session-2.jsonl'),
    [
      userPrompt('how did we decide on auth?', 's-b'), // duplicate of the project-a prompt
      userPrompt(
        'investigate the bug\n<valis_search_results count="1">\n<hit id="d1">a decision</hit>\n</valis_search_results>',
        's-b',
      ),
      userPrompt('write the migration plan', 's-b'),
    ].join('\n'),
  );
});

afterAll(() => {
  rmSync(projectsDir, { recursive: true, force: true });
});

describe('minePrompts', () => {
  it('extracts user prompts', () => {
    const mined = minePrompts({ projectsDir, limit: 100 });
    const texts = mined.map((m) => m.text);
    expect(texts).toContain('refactor the parser module');
    expect(texts).toContain('write the migration plan');
    // sessionId is carried through for provenance.
    const auth = mined.find((m) => m.text === 'refactor the parser module');
    expect(auth?.sessionId).toBe('s-a');
  });

  it('excludes <valis_search_results> injected content from prompt text', () => {
    const mined = minePrompts({ projectsDir, limit: 100 });
    // The injected prompt carried a <valis_search_results> block — it must be dropped.
    expect(mined.some((m) => m.text.includes('<valis_search_results'))).toBe(false);
    expect(mined.some((m) => m.text.includes('investigate the bug'))).toBe(false);
    // Tool-result echoes produce no text and must not appear.
    expect(mined.every((m) => m.text.trim().length > 0)).toBe(true);
  });

  it('dedups identical prompts', () => {
    const mined = minePrompts({ projectsDir, limit: 100 });
    const auth = mined.filter((m) => m.text === 'how did we decide on auth?');
    expect(auth).toHaveLength(1);
  });

  it('respects limit', () => {
    const mined = minePrompts({ projectsDir, limit: 2 });
    expect(mined).toHaveLength(2);
  });
});
