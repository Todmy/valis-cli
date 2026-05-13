/**
 * `handleStore` — the MCP `valis_store` tool entry point.
 *
 * Linear orchestration over four phases:
 *   1. pre-write validation (secrets, dedup, billing, project resolution)
 *   2. pre-write conditional checks (replaces RBAC, depends_on existence)
 *   3. primary write (Postgres `storeDecision` — blocking)
 *   4. post-write fan-out via the side-effect bus (`store-side-effects.ts`)
 *
 * The post-write fan-out used to live inline in this file with 6 nested
 * try/catch blocks. It now lives behind a single port: every best-effort
 * adapter implements `StoreSideEffect`, the bus runs them in parallel,
 * and the handler reads structured output from the result map to build
 * the response.
 *
 * BUG #143 retained: on primary-write failure in CLI-stdio mode the raw
 * decision is appended to the offline queue. In server mode (configOverride
 * present, no fs persistence) the error is surfaced as a structured
 * `infrastructure_error` envelope.
 */

import { loadConfig } from '../../config/store.js';
import { resolveConfig } from '../../config/project.js';
import { detectSecrets } from '../../security/secrets.js';
import { isDuplicate, markAsSeen } from '../../capture/dedup.js';
import { checkUsageOrProceed } from '../../billing/usage.js';
import {
  getSupabaseClient,
  getSupabaseJwtClient,
  storeDecision,
  getDecisionById,
  getDecisionsByIds,
} from '../../cloud/supabase.js';
import type { StoreExtras } from '../../cloud/supabase.js';
import { getQdrantClient, buildProjectFilter, COLLECTION_NAME } from '../../cloud/qdrant.js';
import {
  detectEmbeddingStrategy,
  truncateForEmbedding,
  ClientEmbeddingStrategy,
  DENSE_VECTOR_NAME,
} from '../../cloud/embedding.js';
import { extractLinks, type LinkExtractionResult, type SearchFn } from './link-extractor.js';
import { appendToQueue } from '../../offline/queue.js';
import { canSupersede } from '../../auth/rbac.js';
import { getToken } from '../../auth/jwt.js';
import type { SupabaseClient } from '@supabase/supabase-js';
import { QdrantClient } from '@qdrant/js-client-rest';
import {
  STORE_SIDE_EFFECTS,
  runStoreSideEffects,
  sideEffectOutput,
  type StoreSideEffectContext,
  type StoreSideEffectResult,
  type StoreConfig,
} from './store-side-effects.js';
import type {
  RawDecision,
  StoreArgs,
  StoreResponse,
  StoreErrorResponse,
  StoreSupersededDetail,
  StoreContradictionWarning,
  DecisionStatus,
  Decision,
  ServerConfig,
} from '../../types.js';

// ---------------------------------------------------------------------------
// Auth-mode-aware client + key resolution
// ---------------------------------------------------------------------------

function pickSupabaseClient(
  config: StoreConfig,
  configOverride: ServerConfig | undefined,
): SupabaseClient {
  // Server-side (configOverride) has service_role_key — use it directly.
  // CLI hosted mode uses JWT exchange via getSupabaseJwtClient.
  if (configOverride && config.supabase_service_role_key) {
    return getSupabaseClient(config.supabase_url, config.supabase_service_role_key);
  }
  if (config.auth_mode === 'jwt') {
    return getSupabaseJwtClient(
      config.supabase_url,
      config.member_api_key || config.api_key,
    );
  }
  return getSupabaseClient(config.supabase_url, config.supabase_service_role_key);
}

function pickUsageApiKey(
  config: StoreConfig,
  configOverride: ServerConfig | undefined,
): string {
  if (configOverride && config.supabase_service_role_key) {
    return config.supabase_service_role_key;
  }
  if (config.auth_mode === 'jwt') {
    return config.member_api_key || config.api_key;
  }
  return config.supabase_service_role_key;
}

async function resolveMemberRole(
  supabaseUrl: string,
  memberApiKey: string | null | undefined,
  authMode: string | undefined,
): Promise<string> {
  if (authMode === 'jwt' && memberApiKey) {
    const cache = await getToken(supabaseUrl, memberApiKey);
    if (cache) return cache.role;
  }
  return 'member';
}

// ---------------------------------------------------------------------------
// Pre-write conditional checks
// ---------------------------------------------------------------------------

type PreWriteRejection = { error: string; action: 'blocked' };

interface ReplacesContext {
  target: { id: string; author: string; status: DecisionStatus };
}

/**
 * Validate `args.replaces`: target must exist in the same org AND the caller
 * must satisfy RBAC (admin OR original author). Returns a rejection envelope
 * on failure, or the resolved target on success.
 */
async function validateReplaces(
  supabase: SupabaseClient,
  config: StoreConfig,
  replacesId: string,
): Promise<ReplacesContext | PreWriteRejection> {
  const target = await getDecisionById(supabase, config.org_id, replacesId);
  if (!target) {
    return { error: 'replaces_target_not_found', action: 'blocked' };
  }

  const memberRole = await resolveMemberRole(
    config.supabase_url,
    config.member_api_key,
    config.auth_mode,
  );
  if (!canSupersede(memberRole, config.author_name, target.author)) {
    return { error: 'permission_denied', action: 'blocked' };
  }

  return {
    target: { id: target.id, author: target.author, status: target.status },
  };
}

async function validateDependsOn(
  supabase: SupabaseClient,
  config: StoreConfig,
  dependsOnIds: string[],
): Promise<PreWriteRejection | null> {
  if (dependsOnIds.length === 0) return null;
  const found = await getDecisionsByIds(supabase, config.org_id, dependsOnIds);
  const foundIds = new Set(found.map((d) => d.id));
  const missing = dependsOnIds.filter((id) => !foundIds.has(id));
  if (missing.length > 0) {
    return {
      error: `depends_on_not_found: ${missing.join(', ')}`,
      action: 'blocked',
    };
  }
  return null;
}

function buildExtras(args: StoreArgs): StoreExtras {
  const extras: StoreExtras = {};
  // FR-018: All decisions default to 'proposed' — active requires explicit review
  extras.status = args.status ?? 'proposed';
  if (args.replaces) {
    extras.replaces = args.replaces;
  }
  if (args.depends_on && args.depends_on.length > 0) {
    extras.depends_on = args.depends_on;
  }
  return extras;
}

// ---------------------------------------------------------------------------
// 025: Auto-link enrichment — build a SearchFn bound to (org, project)
// ---------------------------------------------------------------------------

/**
 * Build a `SearchFn` for the LinkExtractor that runs a project-scoped dense
 * Qdrant query and dedups results by parent `decision_id`. Mirrors the
 * pre-store path used by `valis_check_duplicate` but returns the structured
 * `{id, similarity}[]` shape the extractor consumes.
 *
 * Returns `null` when Qdrant credentials are absent (community / self-hosted
 * setups without managed inference). The caller treats `null` as "skip
 * enrichment" rather than failing the store.
 */
function buildAutoLinkSearchFn(
  config: StoreConfig,
  projectId: string,
): SearchFn | null {
  if (!config.qdrant_url || !config.qdrant_api_key) return null;
  const qdrant = getQdrantClient(config.qdrant_url, config.qdrant_api_key);
  return async (text: string) => {
    const strategy = await detectEmbeddingStrategy(qdrant, COLLECTION_NAME);
    const truncated = truncateForEmbedding(text);
    const denseQuery: unknown =
      strategy.mode === 'client'
        ? await (strategy as ClientEmbeddingStrategy).queryForDenseAsync(truncated)
        : strategy.queryForDense(truncated);
    const filter = buildProjectFilter(config.org_id, projectId);
    const results = await qdrant.query(COLLECTION_NAME, {
      query: denseQuery as never,
      using: DENSE_VECTOR_NAME,
      filter,
      limit: 12, // over-fetch — chunked decisions land on the same parent
      with_payload: true,
    });

    // Dedup by parent `decision_id` (chunked decisions share a parent).
    const best = new Map<string, number>();
    for (const point of results.points) {
      const payload = (point.payload ?? {}) as Record<string, unknown>;
      const parentId = (payload.decision_id as string) ?? (point.id as string);
      const score = point.score ?? 0;
      const existing = best.get(parentId);
      if (existing === undefined || score > existing) best.set(parentId, score);
    }
    return Array.from(best.entries())
      .map(([id, similarity]) => ({ id, similarity }))
      .sort((a, b) => b.similarity - a.similarity);
  };
}

// ---------------------------------------------------------------------------
// Response assembly
// ---------------------------------------------------------------------------

function assembleResponse(
  decision: Decision,
  extras: StoreExtras,
  sideEffectResults: Map<string, StoreSideEffectResult>,
): StoreResponse {
  const response: StoreResponse = {
    id: decision.id,
    status: 'stored',
  };
  if (extras.status === 'proposed') {
    response.proposed = true;
  }
  const superseded = sideEffectOutput<StoreSupersededDetail>(sideEffectResults, 'supersede');
  if (superseded) {
    response.superseded = superseded;
  }
  const contradictions = sideEffectOutput<StoreContradictionWarning[]>(
    sideEffectResults,
    'contradiction-detect',
  );
  if (contradictions && contradictions.length > 0) {
    response.contradictions = contradictions;
  }
  return response;
}

// ---------------------------------------------------------------------------
// Primary-write failure handler (BUG #143)
// ---------------------------------------------------------------------------

async function handlePrimaryWriteFailure(
  err: unknown,
  args: StoreArgs,
  raw: RawDecision,
  config: StoreConfig,
  configOverride: ServerConfig | undefined,
): Promise<StoreErrorResponse | StoreResponse> {
  const errorMessage = err instanceof Error ? err.message : String(err);
  console.error(`[store] Backend error: ${errorMessage}`);

  if (configOverride) {
    // Server mode — no fs persistence. Surface a structured error so the
    // agent/operator can triage without prod-log access.
    return {
      error: 'infrastructure_error',
      action: 'blocked',
      error_message: errorMessage,
    };
  }

  // CLI-stdio mode — legitimate offline fallback via local queue.
  try {
    const id = await appendToQueue(raw, config.author_name, 'mcp_store');
    markAsSeen(args.text, args.session_id);
    return {
      id,
      status: 'stored',
      synced: false,
    };
  } catch (queueErr) {
    const queueMsg = queueErr instanceof Error ? queueErr.message : String(queueErr);
    return {
      error: 'queue_unavailable',
      action: 'blocked',
      error_message: `${errorMessage} (offline-queue fallback also failed: ${queueMsg})`,
    };
  }
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

export async function handleStore(
  args: StoreArgs,
  configOverride?: ServerConfig,
): Promise<StoreResponse | StoreErrorResponse> {
  // ── Phase 1: pre-write validation ─────────────────────────────────────
  const config = configOverride ?? (await loadConfig());
  if (!config) {
    return { error: 'not_configured', action: 'blocked' };
  }

  // T023: Resolve project from per-directory config
  const resolved = configOverride ? null : await resolveConfig();
  const projectId =
    args.project_id || configOverride?.project_id || resolved?.project?.project_id;

  // T023: Reject store if no project configured
  if (!projectId) {
    return { error: 'no_project_configured', action: 'blocked' };
  }

  // Secret detection — both text and summary
  const textSecret = await detectSecrets(args.text);
  if (textSecret) {
    return { error: 'secret_detected', pattern: textSecret.pattern, action: 'blocked' };
  }
  if (args.summary) {
    const summarySecret = await detectSecrets(args.summary);
    if (summarySecret) {
      return { error: 'secret_detected', pattern: summarySecret.pattern, action: 'blocked' };
    }
  }

  // Dedup check (session-scoped near-dupe cache)
  if (isDuplicate(args.text, args.session_id)) {
    return { id: 'duplicate', status: 'duplicate' };
  }

  // T023: Include resolved project_id in raw decision for both Supabase and Qdrant
  const raw: RawDecision = {
    text: args.text,
    type: args.type,
    summary: args.summary,
    affects: args.affects,
    confidence: args.confidence,
    project_id: projectId,
    session_id: args.session_id,
  };

  // Billing check (fail-open: never block on billing errors)
  try {
    const usageResult = await checkUsageOrProceed(
      config.supabase_url,
      config.member_api_key || config.api_key,
      config.org_id,
      'store',
    );
    if (!usageResult.allowed) {
      return {
        error: 'usage_limit_reached',
        action: 'blocked',
        upgrade: usageResult.upgrade,
      };
    }
  } catch {
    // Fail-open: billing check failure must never block store operations
  }

  try {
    const supabase = pickSupabaseClient(config, configOverride);

    // ── Phase 2: pre-write conditional checks ──────────────────────────
    let replacesTarget: ReplacesContext['target'] | null = null;
    if (args.replaces) {
      const replacesResult = await validateReplaces(supabase, config, args.replaces);
      if ('error' in replacesResult) return replacesResult;
      replacesTarget = replacesResult.target;
    }

    if (args.depends_on && args.depends_on.length > 0) {
      const dependsOnResult = await validateDependsOn(supabase, config, args.depends_on);
      if (dependsOnResult) return dependsOnResult;
    }

    // ── 025: Auto-link enrichment (BUG #175) ──────────────────────────────
    // Run when the agent did NOT supply depends_on AND there's no replaces
    // (replaces already carries a structural link). Non-blocking: any
    // failure persists `auto_links: { status: 'failed', ... }` and falls
    // through to an empty depends_on.
    const callerSuppliedDeps = (args.depends_on?.length ?? 0) > 0;
    const callerSuppliedReplaces = Boolean(args.replaces);
    let linkExtraction: LinkExtractionResult | null = null;
    if (callerSuppliedDeps) {
      linkExtraction = {
        chosen: [],
        candidates: [],
        threshold: 0.6,
        latency_ms: 0,
        status: 'skipped',
        reason: 'caller_supplied_depends_on',
      };
    } else if (callerSuppliedReplaces) {
      linkExtraction = {
        chosen: [],
        candidates: [],
        threshold: 0.6,
        latency_ms: 0,
        status: 'skipped',
        reason: 'replaces_supplied',
      };
    } else {
      const searchFn = buildAutoLinkSearchFn(config, projectId);
      if (searchFn) {
        linkExtraction = await extractLinks(args.text, searchFn);
        if (linkExtraction.chosen.length > 0) {
          // Best-effort validate — drop any IDs that don't resolve in
          // Postgres rather than fail the write.
          const found = await getDecisionsByIds(supabase, config.org_id, linkExtraction.chosen);
          const validIds = new Set(found.map((d) => d.id));
          linkExtraction.chosen = linkExtraction.chosen.filter((id) => validIds.has(id));
        }
      } else {
        linkExtraction = {
          chosen: [],
          candidates: [],
          threshold: 0.6,
          latency_ms: 0,
          status: 'failed',
          reason: 'qdrant_unavailable',
        };
      }
    }

    const extras = buildExtras(args);
    if (
      linkExtraction.status === 'ok' &&
      linkExtraction.chosen.length > 0 &&
      !extras.depends_on
    ) {
      extras.depends_on = linkExtraction.chosen;
    }

    // ── Phase 3: primary write (blocking) ──────────────────────────────
    const decision = await storeDecision(
      supabase,
      config.org_id,
      raw,
      config.author_name,
      'mcp_store',
      Object.keys(extras).length > 0 ? extras : undefined,
    );

    markAsSeen(args.text, args.session_id);

    // ── Phase 4: side-effect bus (parallel, all best-effort) ───────────
    const ctx: StoreSideEffectContext = {
      decision,
      raw,
      args,
      extras,
      config,
      supabase,
      projectId,
      usageApiKey: pickUsageApiKey(config, configOverride),
      qdrant: () => {
        try {
          return getQdrantClient(config.qdrant_url, config.qdrant_api_key) as QdrantClient;
        } catch {
          return null;
        }
      },
      replacesTarget,
      linkExtraction,
    };

    const sideEffectResults = await runStoreSideEffects(STORE_SIDE_EFFECTS, ctx);

    return assembleResponse(decision, extras, sideEffectResults);
  } catch (err) {
    // BUG #143: distinguish server mode (return structured error) from
    // CLI-stdio mode (legitimate offline-queue fallback).
    return handlePrimaryWriteFailure(err, args, raw, config, configOverride);
  }
}
