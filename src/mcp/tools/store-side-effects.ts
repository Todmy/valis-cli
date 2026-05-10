/**
 * Store side-effect bus — port + adapters for the post-write fan-out.
 *
 * `handleStore` writes a decision to Postgres (the source of truth) and then
 * fans out to several best-effort side-effects: Qdrant dual-write, cluster
 * assignment, usage counter, supersede of a replaced decision, channel push,
 * and contradiction detection.
 *
 * Before this module existed, each effect lived inline in `handleStore` with
 * its own try/catch and bespoke degradation rules. That made:
 *   - the handler hard to read end-to-end (~270 LOC of fan-out)
 *   - adding a seventh effect mean editing the middle of the handler
 *   - tests for the post-write pipeline have to mock the whole handler
 *
 * Each adapter implements `StoreSideEffect`. The bus runs all eligible
 * adapters in parallel via `Promise.allSettled` and returns a per-adapter
 * result map; the handler reads structured output (supersede detail,
 * contradiction warnings) from the map to build the response.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { QdrantClient } from '@qdrant/js-client-rest';
import { upsertDecision } from '../../cloud/qdrant.js';
import { getToken } from '../../auth/jwt.js';
import { ClusterRegistry } from '../../synthesis/cluster-registry.js';
import { incrementUsage } from '../../billing/usage.js';
import {
  buildNewDecisionEvent,
  buildProposedDecisionEvent,
  buildContradictionEvent,
} from '../../channel/push.js';
import { detectContradictions } from '../../contradiction/detect.js';
import { buildAuditPayload, createAuditEntry } from '../../auth/audit.js';
import { HOSTED_SUPABASE_URL } from '../../types.js';
import { resolveApiUrl, resolveApiPath } from '../../cloud/api-url.js';
import type {
  RawDecision,
  StoreArgs,
  StoreSupersededDetail,
  StoreContradictionWarning,
  DecisionStatus,
  Decision,
  ValisConfig,
  ServerConfig,
} from '../../types.js';

/**
 * The store flow accepts both CLI-resolved (`ValisConfig`) and server-injected
 * (`ServerConfig`) configs. The intersection covers every field the bus needs
 * (org/url/keys/auth_mode/author_name/member_id) — extra fields like
 * org_name/invite_code from ValisConfig are unused here.
 */
export type StoreConfig = ValisConfig | ServerConfig;

// ---------------------------------------------------------------------------
// Internal: supersede call against /api/change-status
// ---------------------------------------------------------------------------

async function supersedeRemote(
  supabaseUrl: string,
  serviceRoleKey: string,
  decisionId: string,
  changedBy: string,
  memberApiKey?: string | null,
): Promise<{ old_status: DecisionStatus; new_status: 'superseded' }> {
  // Prefer JWT token (works in hosted mode where serviceRoleKey is empty).
  // Fall back to serviceRoleKey for community/self-hosted mode.
  let bearer = '';
  if (memberApiKey) {
    try {
      const tokenCache = await getToken(supabaseUrl, memberApiKey);
      if (tokenCache) {
        bearer = tokenCache.jwt.token;
      }
    } catch {
      // Token exchange failed — try serviceRoleKey
    }
  }
  if (!bearer && serviceRoleKey) {
    bearer = serviceRoleKey;
  }
  if (!bearer) {
    throw new Error('No valid auth token available for supersede operation');
  }

  const isHosted = supabaseUrl.replace(/\/$/, '') === HOSTED_SUPABASE_URL;
  const apiBase = resolveApiUrl(supabaseUrl, isHosted);
  const url = resolveApiPath(apiBase, 'change-status');
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${bearer}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      decision_id: decisionId,
      new_status: 'superseded',
      changed_by: changedBy,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`change-status failed (HTTP ${res.status}): ${body}`);
  }

  return (await res.json()) as { old_status: DecisionStatus; new_status: 'superseded' };
}

// ---------------------------------------------------------------------------
// Port + result shape
// ---------------------------------------------------------------------------

/** Everything an adapter needs from the post-write moment. */
export interface StoreSideEffectContext {
  /** The freshly-written decision (Postgres row). */
  decision: Decision;
  /** The raw decision that produced it. */
  raw: RawDecision;
  /** Original tool arguments — adapters read `text`, `affects`, etc. */
  args: StoreArgs;
  /** Resolved StoreExtras used for the write (status, replaces, depends_on). */
  extras: { status?: string };
  /** Cluster / billing / supabase access (CLI or server config). */
  config: StoreConfig;
  /** Shared supabase client (already configured per auth mode). */
  supabase: SupabaseClient;
  /** API key to use for usage counter increments (auth-mode aware). */
  usageApiKey: string;
  /**
   * Resolved project UUID. Guaranteed to be a string at this point — Phase 1
   * of the handler short-circuits on `no_project_configured`. Carried
   * explicitly so adapters don't need to re-derive it from raw/args/config.
   */
  projectId: string;
  /**
   * Lazy Qdrant accessor — returns null on instantiation failure. Adapters
   * that need Qdrant either call it once or short-circuit if null.
   */
  qdrant: () => QdrantClient | null;
  /** When `args.replaces` resolves to a real target — null otherwise. */
  replacesTarget: { id: string; author: string; status: DecisionStatus } | null;
}

export type StoreSideEffectStatus = 'ok' | 'skipped' | 'failed';

export interface StoreSideEffectResult<T = unknown> {
  name: string;
  status: StoreSideEffectStatus;
  durationMs: number;
  error?: Error;
  /** Adapter-specific structured output (supersede detail, contradictions). */
  output?: T;
}

export interface StoreSideEffect<T = unknown> {
  name: string;
  /** Conditional gate — skipped adapters are recorded with status='skipped'. */
  shouldRun?(ctx: StoreSideEffectContext): boolean;
  run(ctx: StoreSideEffectContext): Promise<T | void>;
}

// ---------------------------------------------------------------------------
// Adapters
// ---------------------------------------------------------------------------

const qdrantWriteEffect: StoreSideEffect = {
  name: 'qdrant-write',
  async run(ctx) {
    const q = ctx.qdrant();
    if (!q) {
      throw new Error('Qdrant client unavailable');
    }
    await upsertDecision(
      q,
      ctx.config.org_id,
      ctx.decision.id,
      ctx.raw,
      ctx.config.author_name,
      {
        project_id: ctx.raw.project_id,
        source: 'mcp_store',
      },
    );
  },
};

const clusterAssignEffect: StoreSideEffect = {
  name: 'cluster-assign',
  async run(ctx) {
    const q = ctx.qdrant();
    if (!q) {
      throw new Error('Qdrant client unavailable');
    }
    const registry = new ClusterRegistry(q, ctx.config.org_id);
    await registry.assignCluster(ctx.decision.id, ctx.args.text, ctx.args.affects ?? []);
  },
};

const incrementUsageEffect: StoreSideEffect = {
  name: 'increment-usage',
  async run(ctx) {
    await incrementUsage(
      ctx.config.supabase_url,
      ctx.usageApiKey,
      ctx.config.org_id,
      'store',
      ctx.config.auth_mode,
    );
  },
};

const supersedeEffect: StoreSideEffect<StoreSupersededDetail> = {
  name: 'supersede',
  shouldRun: (ctx) => ctx.replacesTarget !== null,
  async run(ctx) {
    if (!ctx.replacesTarget) return;
    const result = await supersedeRemote(
      ctx.config.supabase_url,
      ctx.config.supabase_service_role_key,
      ctx.replacesTarget.id,
      ctx.config.author_name,
      ctx.config.member_api_key,
    );
    return {
      decision_id: ctx.replacesTarget.id,
      old_status: result.old_status,
      new_status: 'superseded',
    };
  },
};

const channelPushEffect: StoreSideEffect = {
  name: 'channel-push',
  async run(ctx) {
    // Channel push integration is wired in `serve` command — building the
    // event here documents the integration point so the adapter is the only
    // place where push semantics live.
    if (ctx.extras.status === 'proposed') {
      buildProposedDecisionEvent(
        ctx.config.author_name,
        ctx.raw.type || 'pending',
        ctx.raw.summary || ctx.args.text.substring(0, 100),
        ctx.decision.id,
      );
    } else {
      buildNewDecisionEvent(
        ctx.config.author_name,
        ctx.raw.type || 'pending',
        ctx.raw.summary || ctx.args.text.substring(0, 100),
      );
    }
  },
};

const contradictionDetectEffect: StoreSideEffect<StoreContradictionWarning[]> = {
  name: 'contradiction-detect',
  async run(ctx) {
    // Qdrant client is optional here — detectContradictions falls back to
    // Tier 1 (area overlap) when Qdrant is unavailable.
    const q = ctx.qdrant();
    const decisionWithProject = {
      ...ctx.decision,
      project_id: ctx.decision.project_id || ctx.projectId,
    };
    const warnings = await detectContradictions(
      ctx.supabase,
      q,
      ctx.config.org_id,
      decisionWithProject,
    );

    if (warnings.length > 0) {
      const newSummary = ctx.raw.summary || ctx.args.text.substring(0, 80);
      for (const w of warnings) {
        try {
          buildContradictionEvent(
            { author: ctx.config.author_name, summary: newSummary },
            { author: w.author, summary: w.summary },
            w.overlap_areas,
          );
        } catch {
          // Channel event build is best-effort
        }
      }

      // Audit entries — best-effort per warning so a single failure doesn't
      // block remaining audits.
      for (const w of warnings) {
        try {
          const auditPayload = buildAuditPayload(
            'contradiction_detected',
            'decision',
            ctx.decision.id,
            ctx.config.member_id || 'unknown',
            ctx.config.org_id,
            {
              newState: {
                decision_a: ctx.decision.id,
                decision_b: w.decision_id,
                overlap_areas: w.overlap_areas,
                similarity: w.similarity,
              },
            },
          );
          await createAuditEntry(ctx.supabase, auditPayload);
        } catch {
          // Audit failures are non-fatal
        }
      }
    }

    return warnings;
  },
};

/**
 * Default registry. Order is informational only — the bus dispatches in
 * parallel via `Promise.allSettled`. Listed in the order they were inline in
 * the original handler for review readability.
 */
export const STORE_SIDE_EFFECTS: StoreSideEffect[] = [
  qdrantWriteEffect,
  clusterAssignEffect,
  incrementUsageEffect,
  supersedeEffect,
  channelPushEffect,
  contradictionDetectEffect,
];

// ---------------------------------------------------------------------------
// Bus
// ---------------------------------------------------------------------------

/**
 * Run all eligible side-effects in parallel. Each adapter is isolated:
 * failures become structured `StoreSideEffectResult` entries, never thrown.
 * Returns a name-keyed map so callers can extract per-adapter output.
 */
export async function runStoreSideEffects(
  effects: StoreSideEffect[],
  ctx: StoreSideEffectContext,
): Promise<Map<string, StoreSideEffectResult>> {
  const results = new Map<string, StoreSideEffectResult>();

  await Promise.allSettled(
    effects.map(async (effect) => {
      if (effect.shouldRun && !effect.shouldRun(ctx)) {
        results.set(effect.name, {
          name: effect.name,
          status: 'skipped',
          durationMs: 0,
        });
        return;
      }

      const startedAt = Date.now();
      try {
        const output = await effect.run(ctx);
        results.set(effect.name, {
          name: effect.name,
          status: 'ok',
          durationMs: Date.now() - startedAt,
          output: output ?? undefined,
        });
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        results.set(effect.name, {
          name: effect.name,
          status: 'failed',
          durationMs: Date.now() - startedAt,
          error,
        });
      }
    }),
  );

  return results;
}

/** Helper: read a typed output from the result map. */
export function sideEffectOutput<T>(
  results: Map<string, StoreSideEffectResult>,
  name: string,
): T | undefined {
  const r = results.get(name);
  if (!r || r.status !== 'ok') return undefined;
  return r.output as T | undefined;
}
