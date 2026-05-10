/**
 * Shared global-config bootstrap for hook handlers.
 *
 * Each handler also resolves a project marker via {@link findProjectMarker}
 * directly (call site composition — session-start runs self-heal between
 * marker resolution and global config, user-prompt-submit runs project-
 * vs-user merge logic, etc.). Splitting marker + global into two helpers
 * lets each handler order them naturally.
 *
 * Constitution III: every helper returns null on any failure (missing
 * file, invalid JSON, missing org_id) so the calling handler can `return`
 * and emit empty stdout.
 */

import { readFile } from 'node:fs/promises';
import { configPath } from './paths.js';

export type { ProjectMarker } from '../config/project.js';

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
