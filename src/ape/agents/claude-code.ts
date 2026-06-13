/**
 * 285 APE harness — ClaudeCodeAdapter.
 *
 * Parses off-the-shelf Claude Code session JSONL on disk (const II: no
 * IDE-stream interception) and, per session, reports for each user prompt
 * whether the agent consulted Valis (an assistant `tool_use` with a valis
 * tool name fired) and whether the prompt carried an injected
 * `<valis_search_results>` block with `<hit` children.
 *
 * Task 3 implements `parseLog` only; `detectToolCall` / `deployTarget` are
 * added in Task 4.
 */

import type { AgentAdapter, ParsedSession, PatchDescriptor } from '../types.js';

/**
 * Detection regexes (named constants — see plan Task 3).
 *
 * Namespace-agnostic: matches both `mcp__valis__valis_search` and
 * `mcp__plugin_valis_valis__valis_search` (and any future valis-bearing
 * MCP namespace). The injection block is identified by `<hit` children,
 * NOT the legacy `<result>` shape (verified in recon).
 */
const VALIS_CALL = /mcp__[a-z_]*valis[a-z_]*__valis_(search|context|store|evolve|update_outcome|lifecycle)/;
const INJECTION_OPEN = /<valis_search_results\b/;
const INJECTION_HIT = /<hit\b/; // NOT <result> — verified in recon

/** Coerce arbitrary user-message `content` into a flat string for matching. */
function userContentToString(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string') {
          return (part as { text: string }).text;
        }
        return '';
      })
      .join('\n');
  }
  return '';
}

/** True iff an assistant message contains a `tool_use` to a valis tool. */
function assistantConsulted(message: unknown): boolean {
  if (!message || typeof message !== 'object') return false;
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return false;
  return content.some(
    (part) =>
      part &&
      typeof part === 'object' &&
      (part as { type?: unknown }).type === 'tool_use' &&
      typeof (part as { name?: unknown }).name === 'string' &&
      VALIS_CALL.test((part as { name: string }).name),
  );
}

export class ClaudeCodeAdapter implements AgentAdapter {
  /**
   * Stream JSONL lines and fold them into a single ParsedSession.
   *
   * Each user message opens a new prompt slot; a subsequent assistant
   * `tool_use` to a valis tool marks the most recent prompt as consulted.
   * Blank and non-JSON lines are skipped without throwing (version-tolerant).
   */
  parseLog(jsonl: string): ParsedSession {
    const prompts: ParsedSession['prompts'] = [];
    let sessionId = '';
    let version: string | undefined;

    for (const rawLine of jsonl.split('\n')) {
      const line = rawLine.trim();
      if (!line) continue;

      let obj: Record<string, unknown>;
      try {
        obj = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue; // non-JSON line — skip, do not throw
      }

      if (typeof obj.sessionId === 'string' && !sessionId) sessionId = obj.sessionId;
      if (typeof obj.version === 'string') version = obj.version;

      if (obj.type === 'user') {
        const text = userContentToString((obj.message as { content?: unknown } | undefined)?.content);
        const injected = INJECTION_OPEN.test(text) && INJECTION_HIT.test(text);
        prompts.push({ text, consulted: false, injected });
      } else if (obj.type === 'assistant' && assistantConsulted(obj.message)) {
        // Attribute the consult to the most recent user prompt.
        if (prompts.length > 0) prompts[prompts.length - 1].consulted = true;
      }
    }

    return { sessionId, version, prompts };
  }

  // Implemented in Task 4.
  detectToolCall(_workerResponse: unknown): { tool: string | null; fired: boolean } {
    throw new Error('detectToolCall not implemented (Task 4)');
  }

  deployTarget(_surface: PatchDescriptor['surface']): PatchDescriptor {
    throw new Error('deployTarget not implemented (Task 4)');
  }
}
