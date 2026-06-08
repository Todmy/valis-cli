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
import { applyInferenceDefaults, type InferenceOutput } from '../../lib/type-inference.js';
import {
  ensurePersonalDrafts,
  PERSONAL_DRAFTS_SENTINEL,
} from '../../cloud/supabase/personal-drafts.js';
import {
  injectGroundTruth,
  type GroundTruthContext,
} from './ground-truth-injector.js';
import { appendToQueue } from '../../offline/queue.js';
import { canSupersede } from '../../auth/rbac.js';
import { getToken } from '../../auth/jwt.js';
import { resolveProjectOrg, getServiceRoleSupabase } from '../../lib/project-access.js';
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
import {
  normalizeStoreStatus,
  type RawDecision,
  type StoreArgs,
  type StoreResponse,
  type StoreErrorResponse,
  type StoreSupersededDetail,
  type StoreContradictionWarning,
  type DecisionStatus,
  type Decision,
  type ServerConfig,
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
  extras.status = normalizeStoreStatus(args.status);
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
  groundTruth: GroundTruthContext | null,
  inference?: InferenceOutput,
): StoreResponse {
  const response: StoreResponse = {
    id: decision.id,
    status: 'stored',
  };
  if (extras.status === 'proposed') {
    response.proposed = true;
  }
  // 034 / FR-005 + FR-006: surface inference flags so callers can detect
  // and override silent inference. Omitted (not `false`) when the caller
  // supplied the field explicitly — the response should not carry noise.
  if (inference?.inferred_type) {
    response.inferred_type = true;
  }
  if (inference?.inferred_summary) {
    response.inferred_summary = true;
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
  if (groundTruth) {
    response.ground_truth = {
      status: groundTruth.status,
      band: groundTruth.band,
      top_similarity: groundTruth.top_similarity,
      candidates: groundTruth.candidates,
      latency_ms: groundTruth.latency_ms,
      ...(groundTruth.reason ? { reason: groundTruth.reason } : {}),
    };
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
    // 036/FR-003 (#90): persist the resolved status so the next startup-sweep
    // flush preserves it (mirrors buildExtras: default 'proposed' per FR-018).
    const id = await appendToQueue(
      raw,
      config.author_name,
      'mcp_store',
      normalizeStoreStatus(args.status),
    );
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
  let config = configOverride ?? (await loadConfig());
  if (!config) {
    return { error: 'not_configured', action: 'blocked' };
  }

  // T023: Resolve project from per-directory config
  const resolved = configOverride ? null : await resolveConfig();
  // 034 / FR-019: callers may pass the sentinel `--project personal-drafts`
  // (or args.project_id === 'personal-drafts'). Strip it here so the
  // normal resolution chain treats it as "no project supplied", which
  // then triggers the FR-008 personal-drafts fallback below.
  const rawArgProjectId =
    args.project_id === PERSONAL_DRAFTS_SENTINEL ? undefined : args.project_id;
  let projectId =
    rawArgProjectId || configOverride?.project_id || resolved?.project?.project_id;
  // 034 / FR-005 companion: track when projectId was resolved via the
  // personal-drafts fallback so the response can flag it explicitly.
  let inferredPersonalDrafts = false;

  // BUG #175: refuse to write when the agent-provided project_id disagrees
  // with the OAuth session's scoped project. Without this guard, the store
  // call silently lands in whichever project the JWT carries — symptom: agent
  // running in /repo-mojob/ writes decisions to `personal` because that's
  // what's in the (stale or wrongly-defaulted) JWT. Matches the search-side
  // detection at tools/search.ts so the agent gets a uniform signal.
  if (
    args.project_id &&
    configOverride?.project_id &&
    args.project_id !== configOverride.project_id
  ) {
    return {
      error: 'project_scope_mismatch',
      action: 'blocked',
      project_scope_mismatch: {
        session_project_id: configOverride.project_id,
        current_project_id: args.project_id,
        action_required: 'restart_session',
      },
    };
  }

  // 034 / FR-008: scope-less fallback. When the caller has no project
  // context (no args.project_id, no JWT-encoded scope, no .valis.json),
  // route the write to the caller's personal-drafts project instead of
  // returning `no_project_configured`. Requires authenticated member
  // context — without it we fall through to the auth_required hard-fail
  // (FR-010) below.
  if (!projectId) {
    const callerSentinel = args.project_id === PERSONAL_DRAFTS_SENTINEL;
    const hasMemberCreds =
      Boolean(config.member_id) &&
      Boolean(config.supabase_service_role_key || config.member_api_key);
    if (hasMemberCreds && config.member_id) {
      try {
        const supabase = pickSupabaseClient(config, configOverride);
        const ensured = await ensurePersonalDrafts(
          supabase,
          config.org_id,
          config.member_id,
        );
        projectId = ensured.projectId;
        inferredPersonalDrafts = true;
      } catch (err) {
        // Fallback creation failed (network / RLS / DB error). If the
        // caller explicitly asked for the sentinel, this is a hard error
        // they should see. Otherwise treat as "no_project_configured" so
        // existing CLI flows still get the legacy message.
        if (callerSentinel) {
          return {
            error: 'infrastructure_error',
            action: 'blocked',
            error_message: `personal-drafts ensure failed: ${err instanceof Error ? err.message : String(err)}`,
          };
        }
        return { error: 'no_project_configured', action: 'blocked' };
      }
    } else {
      // 034 / FR-010: no authenticated session AND no project context.
      // Fail fast with an actionable message.
      return {
        error: 'auth_required',
        action: 'blocked',
        error_message: 'Run `valis login` first to capture decisions.',
      };
    }
  }

  // BUG #176 root-cause fix (companion to issue #54 read-path fix):
  // When `args.project_id` is given AND we have service-role access, resolve
  // the project's actual `org_id` and verify caller membership. This prevents
  // cross-org writes that happen when an OAuth caller (whose `auth.orgId`
  // resolves to the personal org because the JWT has no project claim) calls
  // `valis_store(project_id=team_project)` — without this, the row was
  // written with `org_id=personal, project_id=team_project`, leaving
  // unreachable rows for org-scoped readers.
  //
  // Skip when the OAuth JWT already carried a matching project scope
  // (configOverride.project_id === args.project_id): authenticateRequest
  // already narrowed `org_id` correctly in that path.
  if (
    args.project_id &&
    config.supabase_service_role_key &&
    config.member_id &&
    configOverride?.project_id !== args.project_id
  ) {
    const resolved = await resolveProjectOrg(
      getServiceRoleSupabase(config.supabase_url, config.supabase_service_role_key),
      config.member_id,
      args.project_id,
    );
    if ('error' in resolved) {
      return { error: resolved.error, action: 'blocked' };
    }
    if (resolved.org_id !== config.org_id) {
      // Override the org_id used by every downstream write. Cloning preserves
      // member_id, author_name, role, supabase/qdrant creds, and the funnel
      // emitter — only the org scope shifts to the project's owning org.
      config = { ...config, org_id: resolved.org_id };
    }
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

  // 034 / FR-004 + FR-005 + FR-006 + FR-007: apply content-based inference
  // defaults so the caller can supply only `text` and still get a fully
  // classified row. Explicit args bypass inference (verified by
  // test/lib/type-inference-defaults.test.ts case T024).
  const inference: InferenceOutput = applyInferenceDefaults({
    type: args.type,
    summary: args.summary,
    affects: args.affects,
    text: args.text,
  });

  // T023: Include resolved project_id in raw decision for both Supabase and Qdrant
  const raw: RawDecision = {
    text: args.text,
    type: inference.type,
    summary: inference.summary,
    affects: inference.affects,
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

    // ── 027/Track 4: GroundTruthInjector ──────────────────────────────────
    // Pre-write semantic dedup. Runs FIRST so a duplicate short-circuit can
    // skip the write entirely. The injector is non-blocking — any failure
    // collapses to `injector_failed` and we fall through to LinkExtractor
    // for the lower-threshold (0.6) auto-link behaviour established in 025.
    const callerSuppliedDeps = (args.depends_on?.length ?? 0) > 0;
    const callerSuppliedReplaces = Boolean(args.replaces);
    const searchFn = buildAutoLinkSearchFn(config, projectId);
    let groundTruth: GroundTruthContext | null = null;
    if (searchFn) {
      groundTruth = await injectGroundTruth(args.text, searchFn, {
        callerSuppliedDependsOn: callerSuppliedDeps,
        callerSuppliedReplaces,
      });
    }

    // Duplicate short-circuit — return existing decision ID without writing
    // a new row. Suppressed when the caller supplied `replaces` (explicit
    // supersede intent overrides the injector's verdict).
    if (
      groundTruth &&
      groundTruth.status === 'duplicate_detected' &&
      groundTruth.existing_id
    ) {
      // Validate the existing decision still resolves — protects against
      // a stale Qdrant payload pointing at a deleted Postgres row.
      const found = await getDecisionsByIds(supabase, config.org_id, [
        groundTruth.existing_id,
      ]);
      if (found.length > 0) {
        return {
          id: groundTruth.existing_id,
          status: 'duplicate_detected',
          ground_truth: {
            status: groundTruth.status,
            band: groundTruth.band,
            top_similarity: groundTruth.top_similarity,
            candidates: groundTruth.candidates,
            latency_ms: groundTruth.latency_ms,
          },
        };
      }
      // Existing row vanished — fall through to a normal write and emit a
      // stale-dedup signal via the LinkExtractor failed-result shape later.
    }

    // ── 025: Auto-link enrichment (BUG #175) — fallback to LinkExtractor ──
    // Run when the agent did NOT supply depends_on AND no replaces AND the
    // ground-truth injector did not already auto-link via neighbour-tier.
    // The LinkExtractor uses a lower 0.6 threshold to catch weaker signals
    // that the 0.7 neighbour band misses.
    let linkExtraction: LinkExtractionResult | null = null;
    const groundTruthAutoLinked =
      groundTruth?.status === 'neighbours_linked' && groundTruth.candidates.length > 0;
    if (callerSuppliedDeps) {
      linkExtraction = {
        chosen: [],
        candidates: [],
        threshold: 0.7,
        latency_ms: 0,
        status: 'skipped',
        reason: 'caller_supplied_depends_on',
      };
    } else if (callerSuppliedReplaces) {
      linkExtraction = {
        chosen: [],
        candidates: [],
        threshold: 0.7,
        latency_ms: 0,
        status: 'skipped',
        reason: 'replaces_supplied',
      };
    } else if (groundTruthAutoLinked) {
      // Ground-truth neighbour candidates win — use them for depends_on, skip
      // LinkExtractor's redundant lower-threshold pass.
      const chosen = groundTruth!.candidates.map((c) => c.id);
      const found = await getDecisionsByIds(supabase, config.org_id, chosen);
      const validIds = new Set(found.map((d) => d.id));
      linkExtraction = {
        chosen: chosen.filter((id) => validIds.has(id)),
        candidates: groundTruth!.candidates.map((c) => ({
          id: c.id,
          confidence: c.similarity,
        })),
        threshold: 0.7,
        latency_ms: groundTruth!.latency_ms,
        status: 'ok',
        reason: 'ground_truth_neighbours',
      };
    } else if (searchFn) {
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
        threshold: 0.7,
        latency_ms: 0,
        status: 'failed',
        reason: 'qdrant_unavailable',
      };
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
      inference,
    };

    const sideEffectResults = await runStoreSideEffects(STORE_SIDE_EFFECTS, ctx);

    const response = assembleResponse(decision, extras, sideEffectResults, groundTruth, inference);
    if (inferredPersonalDrafts) {
      response.inferred_project_scope = 'personal-drafts';
    }
    return response;
  } catch (err) {
    // BUG #143: distinguish server mode (return structured error) from
    // CLI-stdio mode (legitimate offline-queue fallback).
    return handlePrimaryWriteFailure(err, args, raw, config, configOverride);
  }
}
