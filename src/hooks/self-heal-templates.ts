/**
 * Canonical content for the self-healing surfaces. Kept in a separate
 * module so tests can import the strings without pulling in fs/process
 * side effects from the heal runner.
 */

export const GLOBAL_KR_START = '<!-- valis:knowledge-retention:start -->';
export const GLOBAL_KR_END = '<!-- valis:knowledge-retention:end -->';

const KR_LINES = [
  '# Knowledge Retention',
  '',
  'Two-layer model:',
  '',
  '1. **Valis (primary)** — durable team knowledge. Decisions, constraints,',
  '   patterns, and lessons that survive across sessions and that future',
  '   teammates (or future me) need to find by intent. The team brain.',
  '   Domain-agnostic: works for any project the team runs together.',
  '   Tools: `valis_search`, `valis_store`, `valis_context`, `valis_lifecycle`.',
  '   On any project where `valis init` has been run (`.valis.json` present),',
  '   Valis is the authoritative source. Call `valis_context` (MCP tool) at',
  '   the start of every new task to load recent team decisions into the',
  '   conversation — they outrank MEMORY.md and Qdrant for work questions.',
  '',
  '2. **Qdrant (ephemeral)** — short-term working memory. Half-formed thoughts,',
  '   in-flight investigation notes, tactical findings useful during the',
  '   *current* week of work but that do not deserve a Valis decision. Treat',
  '   as a scratchpad, not a team brain. Collection name = project directory',
  '   basename.',
  '',
  '## When to use which',
  '',
  '- Choice with rationale → **Valis** via `valis_store`',
  '  (`type: decision|pattern|lesson|constraint`).',
  '- Outcome learned from experience (bug, mistake, win) → **Valis** as `type: lesson`.',
  '- Project-specific convention → **Valis** as `type: pattern`.',
  '- External constraint (legal, infra, client, scheduling, access, cost) → **Valis**',
  '  as `type: constraint`.',
  '- Mid-investigation note ("the third caller of X is Y") → **Qdrant** if',
  '  helpful for the current task, drop after.',
  '- Generic tooling tip ("how to grep for thing Z") → **Qdrant**, project-scoped.',
  '',
  '## On first message',
  '',
  '1. If `.valis.json` exists in cwd → call `valis_context` (MCP tool) to',
  '   load the team decisions; for specific recall use `valis_search`.',
  '2. If no Valis project but Qdrant collection exists → `mcp__qdrant__qdrant-find`',
  '   to pull recent ephemeral context.',
  '',
  '**Migration of legacy MEMORY.md content into Valis** is the recommended',
  '**path**; `valis init` offers it interactively with backup + 30-day decline',
  'suppression.',
];

export const GLOBAL_KR_BODY = KR_LINES.join('\n');

export function canonicalGlobalKrBlock(): string {
  return `${GLOBAL_KR_START}\n${GLOBAL_KR_BODY}\n${GLOBAL_KR_END}`;
}

export const PROJECT_VALIS_START = '<!-- valis:start -->';
export const PROJECT_VALIS_END = '<!-- valis:end -->';

export const SETTINGS_HOOK_COMMANDS = [
  'valis hook session-start',
  'valis hook user-prompt-submit',
  'valis hook pre-tool-use',
  'valis hook pre-compact',
  'valis hook stop',
] as const;

/**
 * Hook commands that earlier versions installed but the current build no
 * longer wires. self-heal removes any matching entries from the user's
 * settings.json on the next run so upgraders get a clean state.
 */
export const SETTINGS_HOOK_COMMANDS_LEGACY = [
  'valis hook post-tool-use',
] as const;
