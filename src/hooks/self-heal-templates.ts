/**
 * Canonical content for the self-healing surfaces. Kept in a separate
 * module so tests can import the strings without pulling in fs/process
 * side effects from the heal runner.
 */

export const GLOBAL_KR_START = '<!-- valis:knowledge-retention:start -->';
export const GLOBAL_KR_END = '<!-- valis:knowledge-retention:end -->';

/**
 * Policy version embedded inside the canonical block. Bumped whenever the
 * agent-instruction policy changes in a way users must adopt automatically
 * (e.g. MIRROR-WRITE rule, failure-mode contract). Self-heal uses this
 * marker to distinguish "stale canonical from a previous CLI version" (auto-
 * upgrade) from "engineer edited the block by hand" (leave alone).
 *
 * Format: ISO-date plus a slug. String-comparable lex order.
 */
export const KR_POLICY_VERSION = '2026-05-19-active-project-scope';
export const KR_POLICY_MARKER_PREFIX = '<!-- valis:policy-version:';
export const KR_POLICY_MARKER_SUFFIX = ' -->';

export function policyMarkerLine(version: string = KR_POLICY_VERSION): string {
  return `${KR_POLICY_MARKER_PREFIX}${version}${KR_POLICY_MARKER_SUFFIX}`;
}

const POLICY_VERSION_PATTERN = /<!--\s*valis:policy-version:([^\s-]+(?:-[^\s-]+)*)\s*-->/;

/**
 * Parse a `<!-- valis:policy-version:X -->` marker out of arbitrary text.
 * Returns the version string or `null` if no marker present. Pure helper.
 */
export function parsePolicyVersion(text: string): string | null {
  const m = text.match(POLICY_VERSION_PATTERN);
  return m ? m[1] : null;
}

const KR_LINES = [
  policyMarkerLine(),
  '',
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
  '2. **Qdrant / mem0 / mem-rs / OpenMemory / etc. (ephemeral)** — short-term',
  '   per-user working memory. Half-formed thoughts, in-flight investigation',
  '   notes, tactical findings useful during the *current* week of work but',
  '   that do not deserve a Valis decision. Treat as a scratchpad, not a',
  '   team brain.',
  '',
  '## ⚠️ ACTIVE PROJECT SCOPE — READ BEFORE EVERY valis_* CALL',
  '',
  'Each turn, the UserPromptSubmit hook injects a `<valis_active_project',
  'project_id="..." project_name="...">` block. When you see it, **you',
  'MUST pass `project_id` from that block as an explicit arg to every',
  'valis_* MCP write** — `valis_store`, `valis_lifecycle`, `valis_update_',
  '`outcome`, `valis_evolve`, `valis_check_diff`. The plugin OAuth',
  'transport does NOT propagate the user\'s `.valis.json` scope to the',
  'remote server automatically (BUG #176) — without an explicit',
  '`project_id`, the call may be rejected (`project_scope_mismatch` /',
  '`no_project_configured`) or, on older backends, silently write to',
  'the wrong project (the BUG that bit the v0.5.3 dogfood: decisions for',
  'project mojob ended up in project personal).',
  '',
  'If no `<valis_active_project>` block is in context AND you must write,',
  'read `.valis.json` from the project root yourself (Read or Bash) FIRST,',
  'then pass its `project_id` explicitly. Never guess.',
  '',
  '## ⚠️ MIRROR-WRITE RULE — READ BEFORE STORING ANY MEMORY',
  '',
  '**Whenever you are about to write to ANY memory / KB tool — `qdrant-store`,',
  '`mem0_add`, `memory_save`, `openmemory_save`, any `save_*` tool, ANY tool',
  'whose purpose is "remember this for later" — you MUST FIRST call**',
  '`valis_store` **with the same content**, then optionally fan out to the',
  'per-user tool. This is non-negotiable.',
  '',
  'Mapping (use these `type` values when calling `valis_store`):',
  '',
  '- Architectural decision, choice between alternatives → `decision`',
  '- External constraint (legal, infra, client, scheduling, cost, access) → `constraint`',
  '- Project convention / repeatable pattern → `pattern`',
  '- Lesson from an outcome (bug, mistake, win, gotcha) → `lesson`',
  '- A "★ Insight" you generated → `lesson`',
  '',
  'Only legitimate Qdrant/mem0-ONLY writes (no Valis mirror needed):',
  '',
  '- In-flight investigation breadcrumbs you will discard within this session',
  '  (e.g. "the third caller of X is Y, holding it for the next 30 minutes").',
  '- Pure tooling tips with zero team-knowledge value ("how to grep for Z").',
  '',
  'Anything more durable than that → `valis_store` first, always. If you cannot',
  'decide, default to `valis_store` — duplicates are cheap, silent data loss is not.',
  '',
  'If `valis_store` fails: STOP. Follow the failure-mode contract below — do',
  'NOT proceed with the scratchpad write. Writing only to Qdrant/mem0 when',
  'Valis is down is the silent-drift bug.',
  '',
  '## Failure-mode contract — do not silently drift',
  '',
  'If a Valis tool fails (auth error, network error, "requires re-authorization",',
  'token expired, server 5xx, anything non-success):',
  '',
  '1. **STOP.** Do not silently fall back to Qdrant / mem0 / any other KB tool',
  '   for the same query. Falling back writes team decisions into a per-user',
  '   scratchpad where the rest of the team will never find them — silent',
  '   data loss.',
  '2. **Surface the failure to the user** with the exact recovery step. For',
  '   the OAuth plugin path: tell them to run `/mcp` to re-authorize. For the',
  '   CLI stdio path: tell them to run `valis whoami` and `valis login`.',
  '3. **Wait** for the user to recover or to explicitly waive Valis ("just use',
  '   qdrant for now"). Explicit waiver is fine; silent drift is not.',
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
