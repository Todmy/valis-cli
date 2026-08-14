/**
 * gh#340 (option A) — make a frozen policy block visible, and offer to
 * un-freeze it without destroying what the user wrote.
 *
 * Option C split the injected block into a managed policy region and a custom
 * region, so blocks written from now on upgrade themselves. It does nothing for
 * a block that was already edited in place: that one has no regions, its body
 * hash matches nothing historical, self-heal classifies it `user_customized`,
 * and every policy bump skips it in silence. The author's own machine sat four
 * generations behind for that reason, across 1,904 sessions, with no notice.
 *
 * This module is the detection half. It never writes — it reports what a block
 * is and what the user added to it, so the caller (`valis doctor`) can show a
 * diff and ask. The offer is deliberately NOT "overwrite or keep": both answers
 * lose. It is "move your text into the custom region", after which the block is
 * managed and the question never comes back.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  GLOBAL_KR_START,
  GLOBAL_KR_END,
  GLOBAL_KR_BODY,
  PROJECT_VALIS_START,
  PROJECT_VALIS_END,
  KR_POLICY_VERSION,
  POLICY_VERSION_HISTORY,
  parsePolicyVersion,
  extractPolicyRegion,
  hasManagedRegions,
} from './self-heal-templates.js';
import { claudeHome } from './paths.js';

export type DriftState =
  /** Managed block on the current policy — nothing to do. */
  | 'current'
  /** No block at all, or no markers. Not this module's problem. */
  | 'absent'
  /** Legacy block, edited in place: the frozen case this exists for. */
  | 'frozen'
  /** Markers are duplicated or the region set is broken — never auto-touched. */
  | 'malformed'
  /**
   * The block carries a policy version this build has never heard of, so it was
   * almost certainly written by a NEWER Valis. Migrating would replace it with
   * this binary's older canonical policy — a downgrade dressed as a repair.
   * Never fixable from here; the answer is to update the CLI.
   */
  | 'newer';

export interface BlockDrift {
  surface: 'global' | 'project';
  path: string;
  state: DriftState;
  /** Policy version the block carries, or null when it predates the marker. */
  blockVersion: string | null;
  /** How many policy generations shipped since this block's. 0 when current. */
  generationsBehind: number;
  /**
   * PREVIEW ONLY — never the thing that gets written.
   *
   * Lines present in the block that are NOT in the canonical body shipping
   * now, shown so a human can judge whether the block holds anything of
   * theirs. Migration moves the block VERBATIM and does not consult this
   * list, because line-set subtraction cannot recover authorship: a line the
   * user happened to write identically to a canonical one, a blank line
   * carrying paragraph structure, or a line quoting a Valis marker would all
   * be dropped. Showing too much here is harmless; writing from it is not.
   *
   * "Best as can be recovered" is literal and worth stating: the superseded
   * bodies are not on disk at runtime (only their hashes are), so a line the
   * OLD policy carried and the current one dropped reads as an addition here.
   * That errs toward showing too much, which the user can trim, rather than
   * silently dropping something they wrote.
   */
  additions: string[];
}

function generationsBehind(version: string | null): number {
  if (version === KR_POLICY_VERSION) return 0;
  const history = POLICY_VERSION_HISTORY as readonly string[];
  const idx = version === null ? -1 : history.indexOf(version);
  // Unknown non-null version → a newer build wrote it; not behind.
  if (version !== null && idx === -1) return 0;
  return history.length - 1 - (idx === -1 ? 0 : idx);
}

function countOccurrences(s: string, needle: string): number {
  let n = 0;
  let i = s.indexOf(needle);
  while (i !== -1) {
    n += 1;
    i = s.indexOf(needle, i + needle.length);
  }
  return n;
}

/** Lines in `block` that no line of `canonical` matches, ignoring blank lines. */
export function extractAdditions(block: string, canonical: string): string[] {
  const known = new Set(
    canonical
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean),
  );
  return block
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      if (!t) return false;
      if (t.startsWith('<!-- valis:')) return false;
      return !known.has(t);
    })
    .map((l) => l.trimEnd());
}

function inspect(
  surface: 'global' | 'project',
  path: string,
  content: string | null,
  start: string,
  end: string,
  canonicalBody: string,
): BlockDrift {
  const base: BlockDrift = {
    surface,
    path,
    state: 'absent',
    blockVersion: null,
    generationsBehind: 0,
    additions: [],
  };

  if (content === null) return base;

  if (!content.includes(start) || !content.includes(end)) return base;
  if (countOccurrences(content, start) > 1 || countOccurrences(content, end) > 1) {
    return { ...base, state: 'malformed' };
  }

  const i = content.indexOf(start);
  const j = content.indexOf(end);
  if (j <= i) return { ...base, state: 'malformed' };
  const between = content.slice(i + start.length, j);
  const version = parsePolicyVersion(extractPolicyRegion(between));

  if (hasManagedRegions(between)) {
    // Managed blocks are self-heal's business, not doctor's — they upgrade on
    // their own. Only a broken region set is worth surfacing here.
    return { ...base, state: 'current', blockVersion: version };
  }
  if (between.includes('<!-- valis:policy:start -->')) {
    return { ...base, state: 'malformed', blockVersion: version };
  }

  if (version === KR_POLICY_VERSION) {
    // Legacy shape, current policy: it will pick up regions on the next bump.
    return { ...base, state: 'current', blockVersion: version };
  }

  if (version !== null && !(POLICY_VERSION_HISTORY as readonly string[]).includes(version)) {
    return { ...base, state: 'newer', blockVersion: version };
  }

  return {
    surface,
    path,
    state: 'frozen',
    blockVersion: version,
    generationsBehind: generationsBehind(version),
    additions: extractAdditions(between, canonicalBody),
  };
}

/**
 * Inspect both CLAUDE.md surfaces. Read-only; safe to call from a hook.
 * `projectDir` may be omitted when only the global surface matters.
 */
export async function detectPolicyDrift(projectDir?: string): Promise<BlockDrift[]> {
  const globalPath = join(claudeHome(), 'CLAUDE.md');
  const out: BlockDrift[] = [
    await inspectContent('global', globalPath, await readOrNull(globalPath)),
  ];
  if (projectDir) {
    const projectPath = join(projectDir, 'CLAUDE.md');
    out.push(await inspectContent('project', projectPath, await readOrNull(projectPath)));
  }
  return out;
}

async function readOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * Classify a block from bytes already in hand.
 *
 * Exported because a caller that intends to WRITE must classify the exact bytes
 * it will rewrite, not re-read the file and hope it is the same one. Reading
 * twice is a TOCTOU window wide enough to delete an edit made in another
 * window (review round 2, P0).
 */
export async function inspectContent(
  surface: 'global' | 'project',
  path: string,
  content: string | null,
): Promise<BlockDrift> {
  if (surface === 'global') {
    return inspect('global', path, content, GLOBAL_KR_START, GLOBAL_KR_END, GLOBAL_KR_BODY);
  }
  const { AGENT_INSTRUCTIONS } = await import('../ide/claude-code.js');
  return inspect(
    'project',
    path,
    content,
    PROJECT_VALIS_START,
    PROJECT_VALIS_END,
    AGENT_INSTRUCTIONS,
  );
}

/** The subset worth telling a human about. */
export function needsAttention(drifts: BlockDrift[]): BlockDrift[] {
  return drifts.filter(
    (d) => d.state === 'frozen' || d.state === 'malformed' || d.state === 'newer',
  );
}

/** Only these may be migrated. `malformed` and `newer` are never rewritten. */
export function migratable(drifts: BlockDrift[]): BlockDrift[] {
  return drifts.filter((d) => d.state === 'frozen');
}
