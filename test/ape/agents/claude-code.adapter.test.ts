/**
 * 285/T004: ClaudeCodeAdapter.detectToolCall + deployTarget.
 *
 * detectToolCall(workerResponse) reads a worker chat-completion response and
 * returns { tool, fired } where fired is true iff the response contains a
 * tool/function call to a valis tool (match VALIS_CALL against the call name).
 *
 * deployTarget(surface) returns a PatchDescriptor for the two real surfaces:
 *   - pull_tool_description → server.ts, anchored on the tool description
 *   - push_injection_template → inject-block.ts, anchored on composeSearchResultsBlock
 */

import { describe, it, expect } from 'vitest';
import { ClaudeCodeAdapter } from '../../../src/ape/agents/claude-code.js';

/** OpenAI-compatible chat-completion response carrying a tool/function call. */
const toolCallResponse = (name: string) => ({
  choices: [
    {
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [{ type: 'function', function: { name, arguments: '{"query":"x"}' } }],
      },
    },
  ],
});

const textResponse = (text: string) => ({
  choices: [{ message: { role: 'assistant', content: text } }],
});

describe('ClaudeCodeAdapter.detectToolCall', () => {
  it('fired=true on valis_search function call', () => {
    const res = new ClaudeCodeAdapter().detectToolCall(
      toolCallResponse('mcp__valis__valis_search'),
    );
    expect(res.fired).toBe(true);
    expect(res.tool).toBe('mcp__valis__valis_search');
  });

  it('fired=true namespace-agnostic (plugin namespace)', () => {
    const res = new ClaudeCodeAdapter().detectToolCall(
      toolCallResponse('mcp__plugin_valis_valis__valis_context'),
    );
    expect(res.fired).toBe(true);
    expect(res.tool).toBe('mcp__plugin_valis_valis__valis_context');
  });

  it('fired=false on plain text', () => {
    const res = new ClaudeCodeAdapter().detectToolCall(
      textResponse('here is my answer, no tool needed'),
    );
    expect(res.fired).toBe(false);
    expect(res.tool).toBe(null);
  });

  it('fired=false on a non-valis tool call', () => {
    const res = new ClaudeCodeAdapter().detectToolCall(toolCallResponse('Bash'));
    expect(res.fired).toBe(false);
    expect(res.tool).toBe(null);
  });

  it('does not throw on malformed/empty response', () => {
    const adapter = new ClaudeCodeAdapter();
    expect(() => adapter.detectToolCall(undefined)).not.toThrow();
    expect(() => adapter.detectToolCall({})).not.toThrow();
    expect(adapter.detectToolCall({}).fired).toBe(false);
    expect(adapter.detectToolCall({}).tool).toBe(null);
  });
});

describe('ClaudeCodeAdapter.deployTarget', () => {
  it('deployTarget(pull) points at server.ts with the description anchor', () => {
    const desc = new ClaudeCodeAdapter().deployTarget('pull_tool_description');
    expect(desc.surface).toBe('pull_tool_description');
    expect(desc.file).toBe('packages/cli/src/mcp/server.ts');
    expect(desc.anchor).toBe("Search the team's shared decision history");
  });

  it('deployTarget(push) points at inject-block.ts', () => {
    const desc = new ClaudeCodeAdapter().deployTarget('push_injection_template');
    expect(desc.surface).toBe('push_injection_template');
    expect(desc.file).toBe('packages/cli/src/hooks/inject-block.ts');
    expect(desc.anchor).toBe('composeSearchResultsBlock');
  });
});
