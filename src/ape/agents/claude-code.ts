/**
 * 285 APE harness — ClaudeCodeAdapter.
 *
 * Parses off-the-shelf Claude Code session JSONL on disk (const II: no
 * IDE-stream interception) and, per session, reports for each user prompt
 * whether the agent consulted Valis (an assistant `tool_use` with a valis
 * tool name fired) and whether the prompt carried an injected
 * `<valis_search_results>` block with `<hit` children.
 *
 * `parseLog` (Task 3); `detectToolCall` / `deployTarget` (Task 4).
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

/**
 * The hook-injected `<valis_search_results>` block is NOT stored inside the
 * user message — Claude Code records it as a separate `type:"attachment"`
 * event whose `attachment.hookEvent === 'UserPromptSubmit'` and whose
 * `attachment.content[]` holds the injected string. Verified against real
 * transcripts under `~/.claude/projects` (2026-06-13): a session with
 * demonstrable injections had 0 user-content matches and N attachment matches.
 * A parser that only scans user content reports injectRate = 0 — a silent lie.
 */
const HOOK_INJECT_EVENT = 'UserPromptSubmit';

/** Stringify an `attachment.content` (array of strings/parts) for matching. */
function attachmentContentToString(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        typeof part === 'string'
          ? part
          : part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string'
            ? (part as { text: string }).text
            : '',
      )
      .join('\n');
  }
  return '';
}

/** True iff a `type:"attachment"` event is a UserPromptSubmit hook carrying an injection block. */
function attachmentInjected(obj: Record<string, unknown>): boolean {
  const att = obj.attachment;
  if (!att || typeof att !== 'object') return false;
  if ((att as { hookEvent?: unknown }).hookEvent !== HOOK_INJECT_EVENT) return false;
  const text = attachmentContentToString((att as { content?: unknown }).content);
  return INJECTION_OPEN.test(text) && INJECTION_HIT.test(text);
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
   * A *prompt* is a `type:"user"` event with STRING content — a typed user
   * turn. `type:"user"` events with array content are tool-result echoes
   * (`list:tool_result`), NOT prompts, and are excluded so the consult/inject
   * rates aren't diluted by them. A subsequent assistant `tool_use` to a valis
   * tool marks the most recent prompt as consulted. A `UserPromptSubmit`
   * attachment carrying a `<valis_search_results>`/`<hit>` block marks the most
   * recent prompt as injected (the injection is a sibling event, not inline in
   * the user message — see HOOK_INJECT_EVENT). An inline injection inside a
   * string user message is also honoured as a fallback (older transcript shape).
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

      const rawContent = (obj.message as { content?: unknown } | undefined)?.content;

      if (obj.type === 'user' && typeof rawContent === 'string') {
        // A typed user turn. Array-content user events are tool_result echoes — skip.
        const injected = INJECTION_OPEN.test(rawContent) && INJECTION_HIT.test(rawContent);
        prompts.push({ text: rawContent, consulted: false, injected });
      } else if (obj.type === 'attachment' && attachmentInjected(obj)) {
        // Hook-injected block — attribute to the most recent prompt.
        if (prompts.length > 0) prompts[prompts.length - 1].injected = true;
      } else if (obj.type === 'assistant' && assistantConsulted(obj.message)) {
        // Attribute the consult to the most recent user prompt.
        if (prompts.length > 0) prompts[prompts.length - 1].consulted = true;
      }
    }

    return { sessionId, version, prompts };
  }

  /**
   * Inspect a worker chat-completion response (OpenAI-compatible) for a
   * tool/function call to a valis tool. Returns `{ tool, fired }` where
   * `fired` is true iff `choices[].message.tool_calls[].function.name`
   * matches `VALIS_CALL` (namespace-agnostic). Malformed / non-valis
   * responses return `{ tool: null, fired: false }` (never throws).
   */
  detectToolCall(workerResponse: unknown): { tool: string | null; fired: boolean } {
    const choices = (workerResponse as { choices?: unknown } | undefined)?.choices;
    if (!Array.isArray(choices)) return { tool: null, fired: false };

    for (const choice of choices) {
      const toolCalls = (choice as { message?: { tool_calls?: unknown } } | undefined)?.message
        ?.tool_calls;
      if (!Array.isArray(toolCalls)) continue;
      for (const call of toolCalls) {
        const name = (call as { function?: { name?: unknown } } | undefined)?.function?.name;
        if (typeof name === 'string' && VALIS_CALL.test(name)) {
          return { tool: name, fired: true };
        }
      }
    }
    return { tool: null, fired: false };
  }

  /**
   * Map an optimizer surface to the real edit site (file + unique anchor).
   * The harness EMITS a patch against these descriptors; a human applies it
   * (const XII). Anchors are verified against the live source in recon.
   */
  deployTarget(surface: PatchDescriptor['surface']): PatchDescriptor {
    switch (surface) {
      case 'pull_tool_description':
        return {
          surface,
          file: 'packages/cli/src/mcp/server.ts',
          anchor: "Search the team's shared decision history",
        };
      case 'push_injection_template':
        return {
          surface,
          file: 'packages/cli/src/hooks/inject-block.ts',
          anchor: 'composeSearchResultsBlock',
        };
      default: {
        const exhaustive: never = surface;
        throw new Error(`unknown deploy surface: ${String(exhaustive)}`);
      }
    }
  }
}
