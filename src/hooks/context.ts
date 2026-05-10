/**
 * Shared hook bootstrap helpers.
 *
 * Each hook handler needs the same two pieces of state — the per-directory
 * project marker and the global `~/.valis/config.json` — but in slightly
 * different orders (session-start runs self-heal between them, post-tool-use
 * gates on the tool name first, etc.). So we expose two thin helpers rather
 * than a single fat bundle, letting handlers compose them.
 *
 * Constitution III: every helper returns null on any failure (missing file,
 * invalid JSON, missing org_id) so the calling handler can `return` and emit
 * empty stdout.
 */

import { readFile } from 'node:fs/promises';
import { configPath } from './paths.js';
import { findProjectMarker } from '../config/project.js';
import type { ProjectMarker } from '../config/project.js';

export type { ProjectMarker } from '../config/project.js';

/**
 * Resolve the marker file (`.valis/config.json` or legacy `.valis.json`).
 * Walks up from `CLAUDE_PROJECT_DIR` or `process.cwd()`. Returns null when
 * no marker is found, the JSON is invalid, or `project_id` is missing.
 */
export async function loadHookMarker(): Promise<ProjectMarker | null> {
  const marker = await findProjectMarker();
  if (!marker || !marker.projectId) return null;
  return marker;
}

const DEFAULT_API_BASE = 'https://valis.krukit.co';

/**
 * Bundle of fields hook handlers commonly need from `~/.valis/config.json`.
 * Returned by {@link loadHookGlobalConfig}.
 *
 * `apiKey` may be empty — handlers that need it should gate explicitly so
 * we still serve the offline branch in session-start when the user is
 * configured but lacks per-member credentials.
 */
export interface HookGlobalConfig {
  /** Raw parsed JSON — for handler-specific fields not on this struct. */
  raw: Record<string, unknown>;
  orgId: string;
  /** Empty string when neither member_api_key nor api_key is set. */
  apiKey: string;
  apiBaseUrl: string;
}

/**
 * Read `~/.valis/config.json` and extract the fields hook handlers share.
 * Returns null when the file is missing, unreadable, invalid JSON, or has
 * no `org_id` (without org_id we cannot key the cache or telemetry).
 */
export async function loadHookGlobalConfig(): Promise<HookGlobalConfig | null> {
  let raw: Record<string, unknown>;
  try {
    const data = await readFile(configPath(), 'utf-8');
    const parsed: unknown = JSON.parse(data);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    raw = parsed as Record<string, unknown>;
  } catch {
    return null;
  }

  const orgId = typeof raw.org_id === 'string' ? raw.org_id : '';
  if (!orgId) return null;

  const memberKey = typeof raw.member_api_key === 'string' ? raw.member_api_key : '';
  const orgKey = typeof raw.api_key === 'string' ? raw.api_key : '';
  const apiKey = memberKey || orgKey;

  const apiBaseUrl =
    typeof raw.api_base_url === 'string' && raw.api_base_url
      ? raw.api_base_url
      : DEFAULT_API_BASE;

  return { raw, orgId, apiKey, apiBaseUrl };
}
