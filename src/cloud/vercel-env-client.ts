/**
 * 026/Track 3a — VercelEnvClient production wiring for the reindex toolkit.
 *
 * Implements the `VercelEnvClient` port from `reindex-orchestrator.ts` by
 * hitting the Vercel REST API directly. Per spec clarification:
 *
 *   "The orchestrator hits Vercel REST API directly using a VERCEL_API_TOKEN
 *    injected via env, and on success records the resulting deployment ID
 *    in the checkpoint."
 *
 * Why direct API (not `vercel env` CLI): a partial-success state — env set
 * but redeploy not triggered — is the most common foot-gun, and only the
 * direct path can reliably reconcile (set env, list deployments, trigger
 * a fresh one, attach the resulting deployment id to the checkpoint).
 *
 * Required env vars at construction:
 *   - VERCEL_API_TOKEN  — token with project-write scope
 *   - VERCEL_PROJECT_ID — production project id
 *   - VERCEL_TEAM_ID    — optional, only when the project lives under a team
 *
 * Failures throw — the orchestrator's `runPhase` wrapper catches and emits
 * `status: 'failed'` with a structured `reason`.
 */

import type { VercelEnvClient } from './reindex-orchestrator.js';

interface VercelEnvClientOpts {
  token: string;
  projectId: string;
  teamId?: string;
  /** Override for unit tests; production uses `fetch` from the runtime. */
  fetchImpl?: typeof fetch;
  /** Base URL — exposed for staging / mock servers. */
  baseUrl?: string;
}

interface VercelEnvVar {
  id: string;
  key: string;
  target: ('production' | 'preview' | 'development')[];
}

const DEFAULT_BASE_URL = 'https://api.vercel.com';
const HTTP_TIMEOUT_MS = 30_000;

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}

export function createVercelEnvClient(opts: VercelEnvClientOpts): VercelEnvClient {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
  const teamSuffix = opts.teamId ? `?teamId=${encodeURIComponent(opts.teamId)}` : '';

  async function api(path: string, init: RequestInit): Promise<unknown> {
    const url = `${baseUrl}${path}${path.includes('?') ? '&' : '?'}${teamSuffix.slice(1)}`;
    const res = await withTimeout(
      fetchImpl(url, {
        ...init,
        headers: {
          Authorization: `Bearer ${opts.token}`,
          'Content-Type': 'application/json',
          ...(init.headers ?? {}),
        },
      }),
      HTTP_TIMEOUT_MS,
      `Vercel API ${init.method ?? 'GET'} ${path}`,
    );
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Vercel API ${init.method ?? 'GET'} ${path} → ${res.status}: ${body.slice(0, 200)}`);
    }
    return res.json();
  }

  return {
    async setEnvVar(name: string, value: string): Promise<{ deployment_id: string }> {
      // 1. Find or upsert the env var. Vercel's project-env endpoint requires
      //    a separate DELETE-then-POST for updates on a single value; the
      //    cleaner contract is to PATCH by id, so we list first then update.
      const list = (await api(
        `/v9/projects/${encodeURIComponent(opts.projectId)}/env`,
        { method: 'GET' },
      )) as { envs: VercelEnvVar[] };
      const existing = list.envs.find(
        (e) => e.key === name && e.target.includes('production'),
      );

      if (existing) {
        await api(
          `/v9/projects/${encodeURIComponent(opts.projectId)}/env/${existing.id}`,
          {
            method: 'PATCH',
            body: JSON.stringify({ value, target: ['production'], type: 'plain' }),
          },
        );
      } else {
        await api(
          `/v10/projects/${encodeURIComponent(opts.projectId)}/env`,
          {
            method: 'POST',
            body: JSON.stringify({
              key: name,
              value,
              target: ['production'],
              type: 'plain',
            }),
          },
        );
      }

      // 2. Trigger a fresh production deployment so the new env takes effect.
      //    Vercel auto-deploys on env change for git-connected projects but
      //    we explicitly trigger to capture the deployment id deterministically.
      const deployment = (await api('/v13/deployments', {
        method: 'POST',
        body: JSON.stringify({
          name: opts.projectId,
          project: opts.projectId,
          target: 'production',
        }),
      })) as { id: string };

      return { deployment_id: deployment.id };
    },
  };
}
