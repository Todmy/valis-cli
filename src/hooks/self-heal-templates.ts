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
 * Format: ISO-date plus a slug. Ordering comes from the position in
 * `POLICY_VERSION_HISTORY` (see `isOlderPolicy`), NOT from string comparison —
 * two generations can share a date, and then lex order is simply wrong.
 */
/**
 * Every policy generation ever shipped, oldest first; the last entry IS the
 * current version. Bumping the policy means appending here — there is no other
 * way to change `KR_POLICY_VERSION`.
 *
 * That indirection exists to make one specific silent failure impossible. Each
 * superseded generation must also have its body hash recorded in self-heal's
 * `HISTORICAL_*_HASHES`, or every install still carrying that generation fails
 * the historical-match gate, is classified `user_customized`, and never
 * receives the new policy — with nothing reporting that it didn't. Because the
 * two lists are now length-coupled (asserted in
 * `test/hooks/library-routing-policy.test.ts`), a bump that forgets the hashes
 * fails the suite instead of stranding users.
 *
 * The first two entries predate the version marker itself; they name the
 * generations whose hashes were recorded retroactively, so index N here lines
 * up with index N of each historical hash list.
 */
export const POLICY_VERSION_HISTORY = [
  'pre-0.5.4',
  '0.5.4-mirror-write',
  '2026-05-19-active-project-scope',
  '2026-08-14-reference-library-routing',
  '2026-08-14-managed-policy-region',
] as const;

export const KR_POLICY_VERSION: string =
  POLICY_VERSION_HISTORY[POLICY_VERSION_HISTORY.length - 1];
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
  '',  '**Read scope vs write target (gh#322):** reads span the active project',
  'PLUS any `linked_projects` declared in the repo\'s `.valis.json`. Writes',
  'always resolve to exactly ONE project — the active one. Widen a read',
  'explicitly with `all_projects: true` or a `project_ids` list.',
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
  '## Reference library — external sources, when a project has one',
  '',
  'Some projects carry a read-only corpus of externally authored works',
  '(standards, handbooks, papers) attached alongside their decisions, reachable',
  'via `library_search` and `library_list`. Valis holds what the team decided;',
  'the library holds what the literature says. Most projects have none —',
  '`library_list` answering `has_library: false` is a legitimate state, not a',
  'fault. To read the library of a project other than the active one, pass',
  '`target_project_id` explicitly; without it the call cannot resolve which',
  'shelf you mean.',
  '',
  'Three rules no tool description can state, because each governs the boundary',
  'between two tools:',
  '',
  '1. **A hybrid question calls both.** "Why did we pick X" is a decision AND a',
  '   citation — run `valis_search` and `library_search`, then answer. Reaching',
  '   for whichever tool the phrasing sounds closest to is the failure mode.',
  '2. **Zero hits in Valis does not close the question.** Never write "there is',
  '   nothing on this" until the library has been asked too.',
  '3. **Cite `chunk_text`, never `contextual_text`** — the second is an',
  '   LLM-written retrieval aid from ingest, not source text. Scores are',
  '   rank-derived, so a healthy library returns its nearest passages whether',
  '   or not they address the question. Read the passage; do not trust the',
  '   number.',
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

export function canonicalGlobalKrBlock(previousBlock?: string): string {
  const body = composeManagedBody(GLOBAL_KR_BODY, previousBlock);
  return `${GLOBAL_KR_START}\n${body}\n${GLOBAL_KR_END}`;
}

export const PROJECT_VALIS_START = '<!-- valis:start -->';
export const PROJECT_VALIS_END = '<!-- valis:end -->';

/**
 * gh#340 option C — a managed region and a region that is never touched.
 *
 * Before this split, the whole block was Valis's to write but users edited it
 * anyway (it is the only place the policy is visible), and self-heal then had
 * to choose between overwriting their text and never upgrading them. It chose
 * the latter, correctly and silently: on the author's own machine the global
 * block sat unchanged through four policy generations, 1,904 refusals, with no
 * report to the user.
 *
 * The split removes the choice. Everything between the POLICY markers is
 * rewritten on every heal with no hash gate, because it is not the user's text.
 * Everything between the CUSTOM markers is carried across verbatim and Valis
 * never reads it for a decision — it is where additions belong now.
 *
 * This does nothing for a block already customized in place; those stay
 * `user_customized` and still need the reporting half of gh#340. It removes the
 * class of failure going forward, which is what it is for.
 */
export const POLICY_REGION_START = '<!-- valis:policy:start -->';
export const POLICY_REGION_END = '<!-- valis:policy:end -->';
export const CUSTOM_REGION_START = '<!-- valis:custom:start -->';
export const CUSTOM_REGION_END = '<!-- valis:custom:end -->';

/** Seeded once into a new custom region; replaced the moment the user writes. */
export const CUSTOM_REGION_PLACEHOLDER =
  'Your own instructions go here. Valis rewrites the policy region above on\nevery upgrade, and never edits anything between these two markers.';

/** How many times `needle` occurs in `s`. */
function countOccurrences(s: string, needle: string): number {
  let n = 0;
  let i = s.indexOf(needle);
  while (i !== -1) {
    n += 1;
    i = s.indexOf(needle, i + needle.length);
  }
  return n;
}

/**
 * Is the block a well-formed managed block?
 *
 * Every one of the four markers must appear EXACTLY once, in order. Anything
 * else — a deleted custom marker, a reversed pair, or one of these strings
 * pasted into the user's own text (entirely plausible in a repo whose docs
 * discuss the markers) — is malformed, and a malformed block is never rewritten.
 * The alternative is worse than doing nothing: `extractCustomRegion` would stop
 * at the wrong offset and the rewrite would drop the user's text on the floor.
 */
export function isWellFormedManagedBlock(block: string): boolean {
  const markers = [
    POLICY_REGION_START,
    POLICY_REGION_END,
    CUSTOM_REGION_START,
    CUSTOM_REGION_END,
  ];
  if (markers.some((m) => countOccurrences(block, m) !== 1)) return false;
  const at = markers.map((m) => block.indexOf(m));
  return at[0] < at[1] && at[1] < at[2] && at[2] < at[3];
}

/**
 * The custom region's contents from an existing block, or `null` when the block
 * predates the split or is malformed. `null` and `''` are deliberately
 * different: the first means "there was no usable region", the second means
 * "the user emptied it".
 *
 * Only the two structural newlines the composer inserted are removed — the rest
 * is returned byte for byte, so an indented code block or a deliberate blank
 * line survives an upgrade unchanged.
 */
export function extractCustomRegion(block: string): string | null {
  if (!isWellFormedManagedBlock(block)) return null;
  const start = block.indexOf(CUSTOM_REGION_START);
  const end = block.indexOf(CUSTOM_REGION_END);
  const raw = block.slice(start + CUSTOM_REGION_START.length, end);
  return raw.replace(/^\n/, '').replace(/\n$/, '');
}

/**
 * True when the block carries a well-formed managed split — i.e. when the
 * policy region may be rewritten without reading, and the custom region can be
 * carried across safely. A malformed block reports false and falls back to the
 * legacy hash gate, which leaves it alone.
 */
export function hasManagedRegions(block: string): boolean {
  return isWellFormedManagedBlock(block);
}

/**
 * Wrap a policy body in the two regions, carrying any existing custom text
 * across. `previousBlock` is the block being replaced, if there is one.
 */
export function composeManagedBody(policyBody: string, previousBlock?: string): string {
  const carried = previousBlock ? extractCustomRegion(previousBlock) : null;
  const custom = carried ?? CUSTOM_REGION_PLACEHOLDER;
  return [
    POLICY_REGION_START,
    policyBody,
    POLICY_REGION_END,
    '',
    CUSTOM_REGION_START,
    custom,
    CUSTOM_REGION_END,
  ].join('\n');
}

/** The policy region's contents, or the whole block when it predates the split. */
export function extractPolicyRegion(block: string): string {
  const start = block.indexOf(POLICY_REGION_START);
  const end = block.indexOf(POLICY_REGION_END);
  if (start === -1 || end === -1 || end < start) return block;
  return block.slice(start + POLICY_REGION_START.length, end);
}

/**
 * Is `version` an older generation than what ships now?
 *
 * Ordered by position in `POLICY_VERSION_HISTORY`, not lexically. The lex
 * comparison this replaces was a trap: it happened to work only while every
 * slug began with an increasing ISO date, and the very next bump broke it —
 * `2026-08-14-managed-policy-region` sorts BEFORE
 * `2026-08-14-reference-library-routing`, so a correct upgrade would have read
 * as a downgrade and every install on that generation would have been stranded.
 *
 * `null` (pre-marker) is older. An UNKNOWN non-null version is not: it is
 * almost always a file written by a NEWER build that this one has never heard
 * of — a rollback, a stale global install, an `npx` cache — and treating it as
 * older would silently downgrade the policy every session, each build fighting
 * the other. Fail closed and leave it alone instead.
 */
export function isOlderPolicy(version: string | null): boolean {
  if (version === null) return true;
  const idx = (POLICY_VERSION_HISTORY as readonly string[]).indexOf(version);
  if (idx === -1) return false;
  return idx < POLICY_VERSION_HISTORY.length - 1;
}

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
