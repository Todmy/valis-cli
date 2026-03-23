import { loadConfig } from '../../config/store.js';
import { detectSecrets } from '../../security/secrets.js';
import { isDuplicate, markAsSeen } from '../../capture/dedup.js';
import {
  getSupabaseClient,
  storeDecision,
  getDecisionById,
  getDecisionsByIds,
} from '../../cloud/supabase.js';
import type { StoreExtras } from '../../cloud/supabase.js';
import { getQdrantClient, upsertDecision } from '../../cloud/qdrant.js';
import { appendToQueue } from '../../offline/queue.js';
import { buildNewDecisionEvent, buildContradictionEvent } from '../../channel/push.js';
import { canSupersede } from '../../auth/rbac.js';
import { getToken } from '../../auth/jwt.js';
import { detectContradictions } from '../../contradiction/detect.js';
import { buildAuditPayload, createAuditEntry } from '../../auth/audit.js';
import type {
  RawDecision,
  StoreArgs,
  StoreResponse,
  StoreErrorResponse,
  StoreSupersededDetail,
  StoreContradictionWarning,
  DecisionStatus,
} from '../../types.js';

// ---------------------------------------------------------------------------
// Supersede helper — POST to change-status edge function
// ---------------------------------------------------------------------------

async function supersedeDecision(
  supabaseUrl: string,
  serviceRoleKey: string,
  decisionId: string,
  changedBy: string,
): Promise<{ old_status: DecisionStatus; new_status: 'superseded' }> {
  const url = `${supabaseUrl}/functions/v1/change-status`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${serviceRoleKey}`,
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
    throw new Error(
      `change-status failed (HTTP ${res.status}): ${body}`,
    );
  }

  const data = (await res.json()) as {
    old_status: DecisionStatus;
    new_status: 'superseded';
  };
  return data;
}

// ---------------------------------------------------------------------------
// Resolve member role — JWT mode returns role, legacy defaults to 'member'
// ---------------------------------------------------------------------------

async function resolveMemberRole(
  supabaseUrl: string,
  memberApiKey: string | null | undefined,
  authMode: string | undefined,
): Promise<string> {
  if (authMode === 'jwt' && memberApiKey) {
    const cache = await getToken(supabaseUrl, memberApiKey);
    if (cache) return cache.role;
  }
  // Legacy mode or token unavailable — default to 'member'
  return 'member';
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

export async function handleStore(
  args: StoreArgs,
): Promise<StoreResponse | StoreErrorResponse> {
  const config = await loadConfig();
  if (!config) {
    return { error: 'not_configured', action: 'blocked' as const };
  }

  // 1. Secret detection
  const secret = detectSecrets(args.text);
  if (secret) {
    return {
      error: 'secret_detected',
      pattern: secret.pattern,
      action: 'blocked' as const,
    };
  }

  // 2. Dedup check
  if (isDuplicate(args.text, args.session_id)) {
    return {
      id: 'duplicate',
      status: 'duplicate' as const,
    };
  }

  const raw: RawDecision = {
    text: args.text,
    type: args.type,
    summary: args.summary,
    affects: args.affects,
    confidence: args.confidence,
    project_id: args.project_id,
    session_id: args.session_id,
  };

  // 3. Try dual write
  try {
    const supabase = getSupabaseClient(config.supabase_url, config.supabase_service_role_key);

    // -----------------------------------------------------------------------
    // Phase 2 pre-write validations
    // -----------------------------------------------------------------------

    // 3a. Validate `replaces` target exists in same org + RBAC check
    let replacesTarget: { id: string; author: string; status: DecisionStatus } | null = null;
    if (args.replaces) {
      const target = await getDecisionById(supabase, config.org_id, args.replaces);
      if (!target) {
        return {
          error: 'replaces_target_not_found',
          action: 'blocked' as const,
        };
      }

      // RBAC: only admin or original author may supersede
      const memberRole = await resolveMemberRole(
        config.supabase_url,
        config.member_api_key,
        config.auth_mode,
      );
      if (!canSupersede(memberRole, config.author_name, target.author)) {
        return {
          error: 'permission_denied',
          action: 'blocked' as const,
        };
      }
      replacesTarget = { id: target.id, author: target.author, status: target.status };
    }

    // 3b. Validate `depends_on` — all IDs must exist in same org
    if (args.depends_on && args.depends_on.length > 0) {
      const found = await getDecisionsByIds(supabase, config.org_id, args.depends_on);
      const foundIds = new Set(found.map((d) => d.id));
      const missing = args.depends_on.filter((id) => !foundIds.has(id));
      if (missing.length > 0) {
        return {
          error: `depends_on_not_found: ${missing.join(', ')}`,
          action: 'blocked' as const,
        };
      }
    }

    // -----------------------------------------------------------------------
    // Build store extras
    // -----------------------------------------------------------------------

    const extras: StoreExtras = {};
    if (args.status) {
      extras.status = args.status;
    }
    if (args.replaces) {
      extras.replaces = args.replaces;
    }
    if (args.depends_on && args.depends_on.length > 0) {
      extras.depends_on = args.depends_on;
    }

    // -----------------------------------------------------------------------
    // Dual write (unchanged pipeline)
    // -----------------------------------------------------------------------

    const decision = await storeDecision(
      supabase,
      config.org_id,
      raw,
      config.author_name,
      'mcp_store',
      Object.keys(extras).length > 0 ? extras : undefined,
    );

    // Qdrant write (best-effort)
    try {
      const qdrant = getQdrantClient(config.qdrant_url, config.qdrant_api_key);
      await upsertDecision(qdrant, config.org_id, decision.id, raw, config.author_name);
    } catch {
      // Qdrant failure — Postgres is source of truth
      console.error('Warning: Qdrant write failed, Postgres succeeded');
    }

    markAsSeen(args.text, args.session_id);

    // -----------------------------------------------------------------------
    // Phase 2 post-write: supersede the replaced decision
    // -----------------------------------------------------------------------

    let superseded: StoreSupersededDetail | undefined;
    if (replacesTarget) {
      try {
        const result = await supersedeDecision(
          config.supabase_url,
          config.supabase_service_role_key,
          replacesTarget.id,
          config.author_name,
        );
        superseded = {
          decision_id: replacesTarget.id,
          old_status: result.old_status,
          new_status: 'superseded',
        };
      } catch (err) {
        // Best-effort: the new decision is stored, but the old one
        // could not be transitioned. Log a warning for operators.
        console.error(
          `Warning: failed to supersede decision ${replacesTarget.id}: ` +
            (err instanceof Error ? err.message : String(err)),
        );
      }
    }

    // -----------------------------------------------------------------------
    // Channel push: notify active sessions about new decision
    // -----------------------------------------------------------------------

    try {
      const _event = buildNewDecisionEvent(
        config.author_name,
        raw.type || 'pending',
        raw.summary || args.text.substring(0, 100),
      );
      // Channel notification would be sent via MCP server.notification()
      // when channel transport is connected. For MVP, event is built but
      // push requires server reference — wired in serve command.
    } catch {
      // Channel push is best-effort
    }

    // -----------------------------------------------------------------------
    // Contradiction detection (Phase 2 — US3)
    // -----------------------------------------------------------------------

    let contradictions: StoreContradictionWarning[] | undefined;
    try {
      // Qdrant client — may be null if unavailable (Tier 1 only fallback)
      let qdrantForDetection = null;
      try {
        qdrantForDetection = getQdrantClient(config.qdrant_url, config.qdrant_api_key);
      } catch {
        // Qdrant unavailable — Tier 1 (area overlap) only
      }

      const warnings = await detectContradictions(
        supabase,
        qdrantForDetection,
        config.org_id,
        decision,
      );

      if (warnings.length > 0) {
        contradictions = warnings;

        // Build contradiction channel events (best-effort)
        const newSummary = raw.summary || args.text.substring(0, 80);
        for (const w of warnings) {
          try {
            const _contradictionEvent = buildContradictionEvent(
              { author: config.author_name, summary: newSummary },
              { author: w.author, summary: w.summary },
              w.overlap_areas,
            );
            // Channel push wired in serve command
          } catch {
            // Channel push is best-effort
          }
        }

        // Create audit entries for each detected contradiction (best-effort)
        for (const w of warnings) {
          try {
            const auditPayload = buildAuditPayload(
              'contradiction_detected',
              'decision',
              decision.id,
              config.member_id || 'unknown',
              config.org_id,
              {
                newState: {
                  decision_a: decision.id,
                  decision_b: w.decision_id,
                  overlap_areas: w.overlap_areas,
                  similarity: w.similarity,
                },
              },
            );
            await createAuditEntry(supabase, auditPayload);
          } catch {
            // Audit failures are non-fatal
          }
        }
      }
    } catch {
      // Contradiction detection is best-effort — never block the store
    }

    const response: StoreResponse = {
      id: decision.id,
      status: 'stored' as const,
    };
    if (superseded) {
      response.superseded = superseded;
    }
    if (contradictions && contradictions.length > 0) {
      response.contradictions = contradictions;
    }
    return response;
  } catch {
    // 4. Offline fallback
    const id = await appendToQueue(raw, config.author_name, 'mcp_store');
    markAsSeen(args.text, args.session_id);

    return {
      id,
      status: 'stored' as const,
      synced: false,
    };
  }
}
