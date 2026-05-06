/**
 * Backend context fetch for the SessionStart hook.
 *
 * Calls GET /api/projects/[id]/context with the per-member API key.
 * Hard 3 s timeout per FR-008. Returns the snapshot or null on any
 * non-200 / network / timeout failure.
 */

import type { ProjectContextSnapshot } from './cache.js';

export interface FetchOptions {
  apiBaseUrl: string;
  apiKey: string;
  projectId: string;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 3000;

export async function fetchContextSnapshot(
  opts: FetchOptions,
): Promise<ProjectContextSnapshot | null> {
  const { apiBaseUrl, apiKey, projectId, timeoutMs = DEFAULT_TIMEOUT_MS } = opts;
  const url = `${apiBaseUrl}/api/projects/${encodeURIComponent(projectId)}/context`;
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const data = (await res.json()) as ProjectContextSnapshot;
    return data;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}
