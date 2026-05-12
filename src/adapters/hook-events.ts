/**
 * Hook event name translation across harnesses.
 *
 * Each harness uses its own naming convention:
 *   - Claude / Codex:  PascalCase (`Stop`, `PreToolUse`, `SessionStart`, ...)
 *   - Gemini:          PascalCase but different names (`AfterAgent`, `BeforeTool`, ...)
 *   - Cursor:          camelCase (`stop`, `preToolUse`, `sessionStart`, ...)
 *   - Copilot:         camelCase (`sessionEnd`, `preToolUse`, ...)
 *   - Windsurf:        snake_case (`pre_user_prompt`, `post_cascade_response`, ...)
 *   - Antigravity:     no hooks (use rules instead)
 *
 * Canonical lingua franca: **Claude's PascalCase**. Every harness translates
 * to/from this. `toCanonical(harness, agentEvent)` reverses; `toHarness(...)`
 * goes forward. Both return undefined when no equivalent exists.
 *
 * Convention for harness-specific events with no cross-agent equivalent
 * (e.g. Windsurf's `pre_run_command`): the mapping table sets
 * `canonical === agent` so `toHarness('windsurf', 'pre_run_command')` is
 * identity, but `toCanonical('windsurf', 'pre_run_command')` ALSO yields
 * the same string. Lookups in other harnesses' tables won't find it, so
 * cross-agent translation correctly returns undefined.
 *
 * Adapted from HarnessKit's `hk-core/src/adapter/hook_events.rs` (Apache-2.0).
 */

export type HarnessName =
  | 'claude-code'
  | 'codex'
  | 'gemini'
  | 'cursor'
  | 'copilot'
  | 'windsurf'
  | 'opencode'
  | 'antigravity';

interface EventMapping {
  canonical: string;
  agent: string;
}

/** Claude + Codex: identity mappings (they already use canonical names). */
const CLAUDE_EVENTS: EventMapping[] = [
  { canonical: 'Stop', agent: 'Stop' },
  { canonical: 'PreToolUse', agent: 'PreToolUse' },
  { canonical: 'PostToolUse', agent: 'PostToolUse' },
  { canonical: 'PostToolUseFailure', agent: 'PostToolUseFailure' },
  { canonical: 'UserPromptSubmit', agent: 'UserPromptSubmit' },
  { canonical: 'SessionStart', agent: 'SessionStart' },
  { canonical: 'SessionEnd', agent: 'SessionEnd' },
  { canonical: 'Notification', agent: 'Notification' },
  { canonical: 'PreCompact', agent: 'PreCompact' },
  { canonical: 'PostCompact', agent: 'PostCompact' },
  { canonical: 'SubagentStart', agent: 'SubagentStart' },
  { canonical: 'SubagentStop', agent: 'SubagentStop' },
  { canonical: 'PermissionRequest', agent: 'PermissionRequest' },
];

/** Codex shares Claude's event names. */
const CODEX_EVENTS: EventMapping[] = CLAUDE_EVENTS;

/** Cursor: camelCase variants. */
const CURSOR_EVENTS: EventMapping[] = [
  { canonical: 'Stop', agent: 'stop' },
  { canonical: 'PreToolUse', agent: 'preToolUse' },
  { canonical: 'PostToolUse', agent: 'postToolUse' },
  { canonical: 'UserPromptSubmit', agent: 'userPromptSubmit' },
  { canonical: 'SessionStart', agent: 'sessionStart' },
  { canonical: 'SessionEnd', agent: 'sessionEnd' },
];

/** Copilot: camelCase, slightly different vocabulary. */
const COPILOT_EVENTS: EventMapping[] = [
  { canonical: 'PreToolUse', agent: 'preToolUse' },
  { canonical: 'PostToolUse', agent: 'postToolUse' },
  { canonical: 'SessionStart', agent: 'sessionStart' },
  { canonical: 'SessionEnd', agent: 'sessionEnd' },
];

/** Gemini: different event vocabulary entirely. */
const GEMINI_EVENTS: EventMapping[] = [
  { canonical: 'PreToolUse', agent: 'BeforeTool' },
  { canonical: 'PostToolUse', agent: 'AfterTool' },
  { canonical: 'SessionStart', agent: 'BeforeAgent' },
  { canonical: 'SessionEnd', agent: 'AfterAgent' },
];

/**
 * Windsurf: snake_case + harness-specific events. Note `pre_run_command`
 * (no canonical equivalent) uses the canonical === agent convention so
 * `toHarness('windsurf', 'pre_run_command')` is identity but cross-harness
 * lookups return undefined.
 */
const WINDSURF_EVENTS: EventMapping[] = [
  { canonical: 'UserPromptSubmit', agent: 'pre_user_prompt' },
  { canonical: 'PostToolUse', agent: 'post_cascade_response' },
  // Harness-specific (no cross-agent equivalent):
  { canonical: 'pre_run_command', agent: 'pre_run_command' },
];

/** OpenCode and Antigravity have no hook system — tables intentionally empty. */
const NO_HOOKS: EventMapping[] = [];

const TABLES: Record<HarnessName, EventMapping[]> = {
  'claude-code': CLAUDE_EVENTS,
  'codex': CODEX_EVENTS,
  'gemini': GEMINI_EVENTS,
  'cursor': CURSOR_EVENTS,
  'copilot': COPILOT_EVENTS,
  'windsurf': WINDSURF_EVENTS,
  'opencode': NO_HOOKS,
  'antigravity': NO_HOOKS,
};

/**
 * Translate from canonical (Claude's PascalCase) to harness-specific.
 * Returns undefined when this harness has no equivalent for the event.
 */
export function toHarness(harness: HarnessName, canonicalEvent: string): string | undefined {
  return TABLES[harness].find((m) => m.canonical === canonicalEvent)?.agent;
}

/**
 * Translate from harness-specific to canonical.
 * Returns undefined when the agent's event has no cross-harness equivalent.
 */
export function toCanonical(harness: HarnessName, agentEvent: string): string | undefined {
  const mapping = TABLES[harness].find((m) => m.agent === agentEvent);
  if (!mapping) return undefined;
  // Harness-specific events use `canonical === agent`; cross-agent translation
  // through these is technically valid (identity) but semantically meaningless.
  // Callers that care should check this themselves.
  return mapping.canonical;
}

/** All harnesses Valis knows about, in canonical display order. */
export const ALL_HARNESSES: HarnessName[] = [
  'claude-code',
  'codex',
  'gemini',
  'cursor',
  'copilot',
  'windsurf',
  'opencode',
  'antigravity',
];
