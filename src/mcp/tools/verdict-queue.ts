/**
 * Feature 042 (T011) — MCP tools for the shared Stage-A review queue.
 *
 * Thin HTTP clients over the web `/api/verdict-queue` endpoint, mirroring the
 * `lifecycle` tool's mutation pattern (resolve a bearer, POST to the web API).
 * The verdict logic + RBAC + conditional writes live server-side in
 * packages/web; these tools are the agent-facing surface. Escalate-first means
 * the agent confirms with the human before calling a resolve/reverse tool — the
 * tool call IS the explicit confirm; assessment never auto-fires it.
 */

import { loadConfig } from '../../config/store.js';
import { getToken } from '../../auth/jwt.js';
import { resolveApiUrl, resolveApiPath } from '../../cloud/api-url.js';
import { HOSTED_SUPABASE_URL, type ServerConfig } from '../../types.js';

export interface VerdictListArgs {
  project_id: string;
  kind?: 'contradiction' | 'proposed_relevance' | 'all';
}
export interface VerdictResolveArgs {
  project_id: string;
  kind: 'contradiction' | 'proposed_relevance';
  item_id: string;
  action: string;
  reason?: string;
}
export interface VerdictReverseArgs {
  project_id: string;
  kind: 'contradiction' | 'proposed_relevance';
  item_id: string;
}

/** Minimal config shape the helpers need — satisfied by both ValisConfig and ServerConfig (loadConfig's union). */
type ConfigLike = { supabase_url: string; member_api_key?: string | null };

/** Resolve an HTTP bearer the web route's authenticateRequest accepts (see lifecycle.ts notes). */
async function resolveBearer(config: ConfigLike): Promise<string> {
  const apiKey = config.member_api_key;
  if (apiKey) {
    const isTmKey = apiKey.startsWith('tm_') || apiKey.startsWith('tmm_');
    if (isTmKey) {
      try {
        const cache = await getToken(config.supabase_url, apiKey);
        if (cache) return cache.jwt.token;
      } catch {
        // fall through to the error below
      }
    } else {
      return apiKey; // OAuth bearer — pass through
    }
  }
  throw new Error(
    'No valid auth token for verdict-queue. Expected tm_/tmm_ API key (exchanged for JWT) or OAuth bearer.',
  );
}

function verdictQueueUrl(config: ConfigLike): string {
  const isHosted = config.supabase_url.replace(/\/$/, '') === HOSTED_SUPABASE_URL;
  return resolveApiPath(resolveApiUrl(config.supabase_url, isHosted), 'verdict-queue');
}

async function loadOrThrow(configOverride?: ServerConfig): Promise<ConfigLike> {
  const config = configOverride ?? (await loadConfig());
  if (!config) throw new Error('Not configured. Run `valis init` first.');
  return config;
}

export async function handleVerdictList(
  args: VerdictListArgs,
  configOverride?: ServerConfig,
): Promise<unknown> {
  const config = await loadOrThrow(configOverride);
  const bearer = await resolveBearer(config);
  const params = new URLSearchParams({ project_id: args.project_id });
  if (args.kind) params.set('kind', args.kind);
  const res = await fetch(`${verdictQueueUrl(config)}?${params.toString()}`, {
    headers: { Authorization: `Bearer ${bearer}` },
  });
  if (!res.ok) {
    throw new Error(`verdict-queue list failed (HTTP ${res.status}): ${await res.text().catch(() => '')}`);
  }
  return res.json();
}

export async function handleVerdictResolve(
  args: VerdictResolveArgs,
  configOverride?: ServerConfig,
): Promise<unknown> {
  const config = await loadOrThrow(configOverride);
  const bearer = await resolveBearer(config);
  const res = await fetch(verdictQueueUrl(config), {
    method: 'POST',
    headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      op: 'action',
      project_id: args.project_id,
      kind: args.kind,
      item_id: args.item_id,
      action: args.action,
      reason: args.reason,
    }),
  });
  if (res.status === 409) {
    return { already_resolved: true };
  }
  if (!res.ok) {
    throw new Error(`verdict-queue resolve failed (HTTP ${res.status}): ${await res.text().catch(() => '')}`);
  }
  return res.json();
}

export async function handleVerdictReverse(
  args: VerdictReverseArgs,
  configOverride?: ServerConfig,
): Promise<unknown> {
  const config = await loadOrThrow(configOverride);
  const bearer = await resolveBearer(config);
  const res = await fetch(verdictQueueUrl(config), {
    method: 'POST',
    headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ op: 'reverse', project_id: args.project_id, kind: args.kind, item_id: args.item_id }),
  });
  if (!res.ok) {
    throw new Error(`verdict-queue reverse failed (HTTP ${res.status}): ${await res.text().catch(() => '')}`);
  }
  return res.json();
}
