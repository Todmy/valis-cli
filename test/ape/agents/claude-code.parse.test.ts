/**
 * 285/T003: ClaudeCodeAdapter.parseLog — namespace-agnostic valis detection.
 *
 * parseLog(jsonl) streams JSONL lines and, per session, returns
 * { sessionId, version, prompts[] } where each user prompt records:
 *   - consulted: an assistant tool_use with a valis tool name appears
 *   - injected:  the user message content contains a <valis_search_results …>
 *                block with <hit children (NOT <result>)
 *
 * Detection is namespace-agnostic: both `mcp__valis__valis_search` and
 * `mcp__plugin_valis_valis__valis_search` count. Real shapes were verified
 * against `~/.claude/projects/.../*.jsonl` (recon).
 */

import { describe, it, expect } from 'vitest';
import { ClaudeCodeAdapter } from '../../../src/ape/agents/claude-code.js';

/** Build one JSONL line from an object. */
const j = (o: unknown) => JSON.stringify(o);

const userPrompt = (text: string, sessionId = 's1') =>
  j({
    type: 'user',
    sessionId,
    message: { role: 'user', content: text },
  });

const assistantToolUse = (toolName: string, sessionId = 's1', version = '2.1.170') =>
  j({
    type: 'assistant',
    sessionId,
    version,
    message: {
      role: 'assistant',
      content: [
        { type: 'text', text: 'let me search' },
        { type: 'tool_use', name: toolName, input: { query: 'x' } },
      ],
    },
  });

describe('ClaudeCodeAdapter.parseLog', () => {
  it('detects mcp__valis__valis_search as consulted', () => {
    const jsonl = [
      userPrompt('how did we decide on auth?'),
      assistantToolUse('mcp__valis__valis_search'),
    ].join('\n');

    const session = new ClaudeCodeAdapter().parseLog(jsonl);
    expect(session.sessionId).toBe('s1');
    expect(session.prompts).toHaveLength(1);
    expect(session.prompts[0].consulted).toBe(true);
    expect(session.prompts[0].injected).toBe(false);
  });

  it('detects mcp__plugin_valis_valis__valis_search as consulted (namespace-agnostic)', () => {
    const jsonl = [
      userPrompt('recall the migration plan'),
      assistantToolUse('mcp__plugin_valis_valis__valis_search'),
    ].join('\n');

    const session = new ClaudeCodeAdapter().parseLog(jsonl);
    expect(session.prompts[0].consulted).toBe(true);
  });

  it('detects <hit> injection block as injected', () => {
    const injected =
      'do the thing\n<valis_search_results count="2">\n<hit id="d1">a decision</hit>\n<hit id="d2">another</hit>\n</valis_search_results>';
    const jsonl = userPrompt(injected);

    const session = new ClaudeCodeAdapter().parseLog(jsonl);
    expect(session.prompts).toHaveLength(1);
    expect(session.prompts[0].injected).toBe(true);
    expect(session.prompts[0].consulted).toBe(false);
  });

  it('does NOT match <result> (legacy false shape) — injected=false', () => {
    const legacy =
      'do the thing\n<valis_search_results count="1">\n<result id="d1">a decision</result>\n</valis_search_results>';
    const jsonl = userPrompt(legacy);

    const session = new ClaudeCodeAdapter().parseLog(jsonl);
    expect(session.prompts[0].injected).toBe(false);
  });

  it('skips blank/non-JSON lines without throwing', () => {
    const jsonl = [
      '',
      '   ',
      'not json at all {',
      userPrompt('a real prompt'),
      '{"partial": ',
      assistantToolUse('mcp__valis__valis_context'),
    ].join('\n');

    let session: ReturnType<ClaudeCodeAdapter['parseLog']>;
    expect(() => {
      session = new ClaudeCodeAdapter().parseLog(jsonl);
    }).not.toThrow();
    session = new ClaudeCodeAdapter().parseLog(jsonl);
    expect(session.prompts).toHaveLength(1);
    expect(session.prompts[0].consulted).toBe(true);
  });

  it('unknown version still parses (version-tolerant)', () => {
    const jsonl = [
      userPrompt('prompt under a weird version'),
      assistantToolUse('mcp__valis__valis_search', 's1', '99.0.0-canary'),
    ].join('\n');

    const session = new ClaudeCodeAdapter().parseLog(jsonl);
    expect(session.version).toBe('99.0.0-canary');
    expect(session.prompts[0].consulted).toBe(true);
  });
});
