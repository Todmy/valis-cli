/**
 * `valis link` / `valis unlink` — manage the repo's read scope (gh#322).
 *
 * Usage:
 *   valis link                 List the currently linked projects by name
 *   valis link <name>          Add a project to the read scope
 *   valis unlink <name>        Remove one
 *
 * Linked projects widen what searches READ. They never widen what a store
 * WRITES — that always lands in the active project. Names, not UUIDs, are the
 * surface here: the terminal is a human surface.
 *
 * @module commands/link
 */

import { readFile, writeFile } from 'node:fs/promises';
import pc from 'picocolors';
import { loadConfig } from '../config/store.js';
import { findProjectConfigPath } from '../config/project.js';
import { getSupabaseClient, listMemberProjects, type ProjectInfo } from '../cloud/supabase.js';

/** Matches `linked_projects.max(20)` in `projectConfigSchema`. */
const LINK_CAP = 20;

interface CommandOptions {
  cwd?: string;
}

interface Marker {
  path: string;
  raw: Record<string, unknown>;
  activeProjectId: string;
  linked: string[];
}

/**
 * Read the nearest project marker, preserving every key. The rewrite must not
 * drop fields this command knows nothing about (`per_prompt_augmentation` and
 * friends live in the same file), so the raw object is carried through rather
 * than a parsed subset.
 */
async function readMarker(cwd: string): Promise<Marker | null> {
  const path = await findProjectConfigPath(cwd);
  if (!path) return null;
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf-8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const raw = parsed as Record<string, unknown>;
    const activeProjectId = typeof raw.project_id === 'string' ? raw.project_id : '';
    if (!activeProjectId) return null;
    const linked = Array.isArray(raw.linked_projects)
      ? (raw.linked_projects as unknown[]).filter((v): v is string => typeof v === 'string')
      : [];
    return { path, raw, activeProjectId, linked };
  } catch {
    return null;
  }
}

async function writeLinked(marker: Marker, linked: string[]): Promise<void> {
  const next = { ...marker.raw, linked_projects: linked };
  await writeFile(marker.path, JSON.stringify(next, null, 2) + '\n', 'utf-8');
}

async function loadProjects(): Promise<ProjectInfo[]> {
  const config = await loadConfig();
  if (!config || !config.member_id) {
    console.error(pc.red('Error: not authenticated. Run `valis init` first.'));
    process.exit(1);
  }
  const supabase = getSupabaseClient(config.supabase_url, config.supabase_service_role_key);
  try {
    return await listMemberProjects(supabase, config.member_id);
  } catch (err) {
    console.error(pc.red(`Failed to list projects: ${(err as Error).message}`));
    process.exit(1);
  }
}

function requireMarker(marker: Marker | null): asserts marker is Marker {
  if (!marker) {
    console.error(pc.red('No project configured here. Run `valis init` first.'));
    process.exit(1);
  }
}

/**
 * Case-insensitive name match. Two projects whose names differ only in case
 * are a real ambiguity, not a near-miss to guess at — the caller reports both
 * rather than picking one.
 */
function matchByName(projects: ProjectInfo[], name: string): ProjectInfo[] {
  const lower = name.toLowerCase();
  return projects.filter((p) => p.name.toLowerCase() === lower);
}

export async function linkCommand(
  name: string | undefined,
  options: CommandOptions = {},
): Promise<void> {
  const cwd = options.cwd ?? process.cwd();
  const marker = await readMarker(cwd);
  requireMarker(marker);

  const projects = await loadProjects();

  if (!name) {
    if (marker.linked.length === 0) {
      console.log(pc.dim('No linked projects. Reads cover the active project only.'));
      console.log(pc.dim('Add one with `valis link <name>`.'));
      return;
    }
    console.log(pc.bold('Linked projects (read scope):\n'));
    for (const id of marker.linked) {
      const match = projects.find((p) => p.id === id);
      // An id we can no longer resolve is named as such rather than dropped —
      // a silently shortened list would misstate where searches look.
      console.log(match ? `  - ${match.name}` : `  - ${id} ${pc.yellow('(no longer accessible)')}`);
    }
    console.log(pc.dim('\nWrites still go to the active project.'));
    return;
  }

  const matches = matchByName(projects, name);
  if (matches.length === 0) {
    console.error(pc.red(`No accessible project named "${name}".`));
    console.error(pc.dim('\nAccessible projects:'));
    for (const p of projects) console.error(pc.dim(`  - ${p.name}`));
    process.exit(1);
  }
  if (matches.length > 1) {
    console.error(pc.red(`"${name}" matches more than one project:`));
    for (const p of matches) console.error(pc.dim(`  - ${p.name} (${p.id})`));
    console.error(pc.dim('\nRename one, or pass the exact project id.'));
    process.exit(1);
  }

  const target = matches[0]!;
  if (target.id === marker.activeProjectId) {
    console.error(pc.red(`"${target.name}" is the active project — it is already in scope.`));
    process.exit(1);
  }
  if (marker.linked.includes(target.id)) {
    console.log(pc.yellow(`"${target.name}" is already linked. No changes made.`));
    return;
  }
  if (marker.linked.length >= LINK_CAP) {
    console.error(pc.red(`Cannot link more than ${LINK_CAP} projects.`));
    console.error(pc.dim('Unlink one first with `valis unlink <name>`.'));
    process.exit(1);
  }

  await writeLinked(marker, [...marker.linked, target.id]);
  console.log(pc.green(`Linked "${target.name}".`) + pc.dim(' Searches now read from it too.'));
  console.log(pc.dim('Writes still go to the active project.'));
}

export async function unlinkCommand(
  name: string,
  options: CommandOptions = {},
): Promise<void> {
  const cwd = options.cwd ?? process.cwd();
  const marker = await readMarker(cwd);
  requireMarker(marker);

  const projects = await loadProjects();
  const matches = matchByName(projects, name);
  const targetId = matches.length === 1 ? matches[0]!.id : undefined;

  // Accept a raw id too, so an entry whose project is no longer accessible
  // (and therefore has no resolvable name) can still be removed.
  const id = targetId && marker.linked.includes(targetId)
    ? targetId
    : marker.linked.includes(name)
      ? name
      : undefined;

  if (!id) {
    console.error(pc.red(`"${name}" is not a linked project.`));
    if (marker.linked.length > 0) {
      console.error(pc.dim('\nLinked:'));
      for (const linkedId of marker.linked) {
        const match = projects.find((p) => p.id === linkedId);
        console.error(pc.dim(`  - ${match ? match.name : linkedId}`));
      }
    }
    process.exit(1);
  }

  await writeLinked(marker, marker.linked.filter((entry) => entry !== id));
  const label = projects.find((p) => p.id === id)?.name ?? id;
  console.log(pc.green(`Unlinked "${label}".`));
}
