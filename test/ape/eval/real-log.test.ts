/**
 * 285/T014: real-log eval — ape/eval/real-log.ts.
 *
 * evalRealLog({ projectsDir, adapter }) parses every session JSONL under
 * `projectsDir` via `adapter.parseLog`, aggregating the fraction of prompts
 * that led to a consult (`consulted`) and that carried an injection
 * (`injected`). This is the no-labels baseline — pure observation of how
 * often the live hook/tool path actually fires in real sessions.
 *
 * Returns { sessions, prompts, consultRate, injectRate }.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evalRealLog } from '../../../src/ape/eval/real-log.js';
import { ClaudeCodeAdapter } from '../../../src/ape/agents/claude-code.js';

/** Build one JSONL line from an object. */
const j = (o: unknown) => JSON.stringify(o);

const userPrompt = (text: string, sessionId: string) =>
  j({ type: 'user', sessionId, message: { role: 'user', content: text } });

const assistantToolUse = (toolName: string, sessionId: string) =>
  j({
    type: 'assistant',
    sessionId,
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', name: toolName, input: { query: 'x' } }],
    },
  });

/** A prompt carrying an injected <valis_search_results> block with <hit children. */
const injectedPrompt = (sessionId: string) =>
  userPrompt(
    'do the thing\n<valis_search_results count="1">\n<hit id="d1">a decision</hit>\n</valis_search_results>',
    sessionId,
  );

let projectsDir: string;

beforeAll(() => {
  projectsDir = mkdtempSync(join(tmpdir(), 'ape-reallog-'));

  // project-a/session-1.jsonl — 2 prompts: 1 consulted, 1 plain.
  const a = join(projectsDir, 'project-a');
  mkdirSync(a, { recursive: true });
  writeFileSync(
    join(a, 'session-1.jsonl'),
    [
      userPrompt('how did we decide on auth?', 's-a'),
      assistantToolUse('mcp__valis__valis_search', 's-a'),
      userPrompt('refactor the parser module', 's-a'),
    ].join('\n'),
  );

  // project-b/session-2.jsonl — 2 prompts: 1 injected, 1 plain (no consults).
  const b = join(projectsDir, 'project-b');
  mkdirSync(b, { recursive: true });
  writeFileSync(
    join(b, 'session-2.jsonl'),
    [injectedPrompt('s-b'), userPrompt('write the migration plan', 's-b')].join('\n'),
  );
});

afterAll(() => {
  rmSync(projectsDir, { recursive: true, force: true });
});

describe('evalRealLog', () => {
  it('computes consultRate across sessions', () => {
    const r = evalRealLog({ projectsDir, adapter: new ClaudeCodeAdapter() });
    // 4 prompts total, 1 consulted → 0.25.
    expect(r.sessions).toBe(2);
    expect(r.prompts).toBe(4);
    expect(r.consultRate).toBeCloseTo(0.25, 10);
  });

  it('computes injectRate', () => {
    const r = evalRealLog({ projectsDir, adapter: new ClaudeCodeAdapter() });
    // 4 prompts total, 1 injected → 0.25.
    expect(r.injectRate).toBeCloseTo(0.25, 10);
  });

  it('reproducible on the same fixtures', () => {
    const adapter = new ClaudeCodeAdapter();
    const a1 = evalRealLog({ projectsDir, adapter });
    const a2 = evalRealLog({ projectsDir, adapter });
    expect(a1).toEqual(a2);
  });

  it('empty dir → zeroed counts, no throw', () => {
    const empty = mkdtempSync(join(tmpdir(), 'ape-reallog-empty-'));
    try {
      const r = evalRealLog({ projectsDir: empty, adapter: new ClaudeCodeAdapter() });
      expect(r).toEqual({ sessions: 0, prompts: 0, consultRate: 0, injectRate: 0 });
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
