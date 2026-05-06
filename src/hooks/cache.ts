/**
 * Local cache for ProjectContextSnapshot.
 *
 * Storage: ~/.valis/cache/<org_id>/<project_id>.json
 * Permissions: 0600 (POSIX best-effort on Windows)
 * Writes: atomic via tempfile-rename
 *
 * Per data-model.md §1 + research.md R-03 + plan.md (additive cache directory).
 */

import { readFile, writeFile, mkdir, rename, unlink, chmod } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { cachePath } from './paths.js';

export interface DecisionSummary {
  id: string;
  summary: string;
  status: 'active' | 'proposed' | 'deprecated' | 'superseded';
  type: 'decision' | 'pattern' | 'lesson' | 'constraint';
  affects: string[];
  last_visited_at?: string;
  score: number;
}

export interface ContradictionSummary {
  id: string;
  decision_a_id: string;
  decision_b_id: string;
  summary: string;
  flagged_at: string;
}

export interface BlockEnvelope {
  purpose: string;
  precedence: string;
  for_session_template: string;
}

export interface ProjectContextSnapshot {
  org_id: string;
  org_name: string;
  project_id: string;
  project_name: string;
  fetched_at: string;
  ttl_seconds: number;
  enforcement_mode: 'advisory' | 'block' | 'report-only';
  decision_count: number;
  violation_count: number;
  decisions: DecisionSummary[];
  recent_contradictions: ContradictionSummary[];
  served_from_cache?: boolean;
  cache_age_seconds?: number;
  block_envelope: BlockEnvelope;
}

export const DEFAULT_TTL_SECONDS = 300;

export async function read(
  orgId: string,
  projectId: string,
): Promise<ProjectContextSnapshot | null> {
  try {
    const data = await readFile(cachePath(orgId, projectId), 'utf-8');
    return JSON.parse(data) as ProjectContextSnapshot;
  } catch {
    return null;
  }
}

export async function write(
  orgId: string,
  projectId: string,
  payload: ProjectContextSnapshot,
): Promise<void> {
  const target = cachePath(orgId, projectId);
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  const tmp = `${target}.${randomBytes(6).toString('hex')}.tmp`;
  await writeFile(tmp, JSON.stringify(payload), { encoding: 'utf-8', mode: 0o600 });
  try {
    await chmod(tmp, 0o600);
  } catch {
    /* non-POSIX best-effort */
  }
  await rename(tmp, target);
}

export async function invalidate(orgId: string, projectId: string): Promise<void> {
  try {
    await unlink(cachePath(orgId, projectId));
  } catch {
    /* idempotent */
  }
}

export function isFresh(
  snapshot: ProjectContextSnapshot,
  ttlSeconds: number = DEFAULT_TTL_SECONDS,
): boolean {
  const fetchedMs = Date.parse(snapshot.fetched_at);
  if (Number.isNaN(fetchedMs)) return false;
  const ageSeconds = (Date.now() - fetchedMs) / 1000;
  return ageSeconds < ttlSeconds;
}

export function ageSeconds(snapshot: ProjectContextSnapshot): number {
  const fetchedMs = Date.parse(snapshot.fetched_at);
  if (Number.isNaN(fetchedMs)) return Number.POSITIVE_INFINITY;
  return Math.floor((Date.now() - fetchedMs) / 1000);
}
