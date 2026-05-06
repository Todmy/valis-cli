/**
 * Walk up from CLAUDE_PROJECT_DIR (or process.cwd()) to find the nearest
 * .valis.json marking a Valis-configured directory (FR-004).
 *
 * Returns null if no marker is found within MAX_WALK_DEPTH ancestors.
 */

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export interface ProjectMarker {
  /** Resolved directory containing .valis.json. */
  projectDir: string;
  /** Parsed contents of .valis.json. */
  config: Record<string, unknown>;
  /** Project ID from config (defensive fallback to '' if missing). */
  projectId: string;
  /** Project name from config (defensive fallback to projectDir basename). */
  projectName: string;
}

const MAX_WALK_DEPTH = 32;

export async function resolveProjectMarker(
  startDir?: string,
): Promise<ProjectMarker | null> {
  const start = startDir ?? process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
  let cur = start;
  for (let depth = 0; depth < MAX_WALK_DEPTH; depth++) {
    const candidate = join(cur, '.valis.json');
    try {
      const data = await readFile(candidate, 'utf-8');
      const parsed = JSON.parse(data) as Record<string, unknown>;
      const projectId = typeof parsed.project_id === 'string' ? parsed.project_id : '';
      const projectName =
        typeof parsed.project_name === 'string' ? parsed.project_name : cur.split('/').pop() ?? cur;
      return { projectDir: cur, config: parsed, projectId, projectName };
    } catch {
      /* keep walking */
    }
    const parent = dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
  return null;
}
