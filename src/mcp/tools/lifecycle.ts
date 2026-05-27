import { loadConfig } from '../../config/store.js';
import { getSupabaseClient, getSupabaseJwtClient, getDecisionById } from '../../cloud/supabase.js';
import { getToken } from '../../auth/jwt.js';
import { canPin } from '../../auth/rbac.js';
import { buildAuditPayload, createAuditEntry } from '../../auth/audit.js';
import { buildProposedPromotedEvent, buildProposedRejectedEvent } from '../../channel/push.js';
import { resolveApiUrl, resolveApiPath } from '../../cloud/api-url.js';
import { canWriteToProject, getServiceRoleSupabase } from '../../lib/project-access.js';
import type {
  LifecycleArgs,
  LifecycleResponse,
  LifecycleStatusChange,
  LifecycleHistoryResponse,
  LifecycleHistoryEntry,
  LifecyclePinResponse,
  DecisionStatus,
  ServerConfig,
} from '../../types.js';
import { HOSTED_SUPABASE_URL } from '../../types.js';

export async function handleLifecycle(args: LifecycleArgs, configOverride?: ServerConfig): Promise<LifecycleResponse> {
  const config = configOverride ?? await loadConfig();
  if (!config) {
    throw new Error('Not configured. Run `valis init` first.');
  }

  // Issue #54: when `project_id` is provided, switch to the service-role
  // client and gate the call on actual project membership. The JWT client
  // can only see decisions in the caller's auth-resolved org — a cross-org
  // decision (the common plugin/OAuth case) would fail with "Invalid API
  // key" or zero-row WHERE matches. Membership precheck closes the
  // privilege-escalation hole the service-role bypass would otherwise open.
  let supabase = config.auth_mode === 'jwt'
    ? getSupabaseJwtClient(config.supabase_url, config.member_api_key || config.api_key)
    : getSupabaseClient(config.supabase_url, config.supabase_service_role_key);

  if (args.project_id) {
    if (!config.supabase_service_role_key) {
      throw new Error(
        `project_id parameter requires service-role access, which is unavailable in CLI stdio mode. ` +
        `Remove project_id and rely on the auth-resolved org, or switch to the plugin/OAuth path.`,
      );
    }
    if (config.member_id) {
      const allowed = await canWriteToProject(
        getServiceRoleSupabase(config.supabase_url, config.supabase_service_role_key),
        config.member_id,
        args.project_id,
      );
      if (!allowed) {
        throw new Error(`project_access_denied: Not a member of project ${args.project_id}.`);
      }
    }
    supabase = getServiceRoleSupabase(config.supabase_url, config.supabase_service_role_key);
  }

  if (args.action === 'history') {
    return await getHistory(supabase, args.decision_id);
  }

  // -------------------------------------------------------------------------
  // T043: Pin / Unpin (US5)
  // -------------------------------------------------------------------------

  if (args.action === 'pin' || args.action === 'unpin') {
    // RBAC: only admins may pin/unpin decisions
    let memberRole = 'member';
    if (config.auth_mode === 'jwt' && config.member_api_key) {
      try {
        const cache = await getToken(config.supabase_url, config.member_api_key);
        if (cache) memberRole = cache.role;
      } catch {
        // Token fetch failed — default to 'member' (deny pin)
      }
    }
    if (!canPin(memberRole)) {
      throw new Error('admin_required: Only admins may pin or unpin decisions.');
    }
    return await handlePinUnpin(
      supabase,
      config.org_id,
      args.decision_id,
      args.action === 'pin',
      config.author_name,
      config.member_id,
      args.project_id,
    );
  }

  // -------------------------------------------------------------------------
  // T012: Resolve target status for proposed workflow audit trail
  // -------------------------------------------------------------------------

  // deprecate or promote
  const newStatus: DecisionStatus = args.action === 'deprecate' ? 'deprecated' : 'active';

  // Fetch the current decision to know old_status for audit trail
  let oldDecision:
    | { status: DecisionStatus; summary: string | null; detail: string; author: string; project_id: string | null }
    | null = null;
  try {
    const fetched = await getDecisionById(
      supabase,
      config.org_id,
      args.decision_id,
      args.project_id ?? null,
    );
    if (fetched) {
      oldDecision = {
        status: fetched.status,
        summary: fetched.summary,
        detail: fetched.detail,
        author: fetched.author,
        project_id: (fetched as { project_id?: string | null }).project_id ?? null,
      };
    }
  } catch {
    // Best-effort — the change-status edge function will validate
  }

  try {
    // Resolve auth token for the change-status HTTP call.
    //
    // Three auth shapes the route's authenticateRequest accepts:
    //   1. `tm_*` / `tmm_*` API key — needs JWT exchange via getToken
    //   2. OAuth bearer token (plugin mode) — used directly, NO exchange
    //   3. Supabase user JWT (dashboard) — used directly
    //
    // CRITICAL: `supabase_service_role_key` is NOT a valid HTTP API auth
    // token. It's the master DB key for service-role Supabase clients. The
    // route's authenticateRequest rejects it. The previous "fallback to
    // service_role" branch produced 401 in OAuth mode whenever the JWT
    // exchange silently failed (the `tm_` exchange flow does not accept
    // OAuth bearer formats). See Valis lesson b0c47dfc.
    let bearer = '';
    const apiKey = config.member_api_key;
    if (apiKey) {
      const isTmKey = apiKey.startsWith('tm_') || apiKey.startsWith('tmm_');
      if (isTmKey) {
        try {
          const tokenCache = await getToken(config.supabase_url, apiKey);
          if (tokenCache) {
            bearer = tokenCache.jwt.token;
          }
        } catch {
          // Exchange failed — leave bearer empty so the precondition check
          // below surfaces a clean error instead of a misleading 401.
        }
      } else {
        // OAuth bearer (or any non-`tm_` token format) — pass through.
        bearer = apiKey;
      }
    }
    if (!bearer) {
      throw new Error(
        'No valid auth token available for change-status operation. ' +
        'Expected tm_/tmm_ API key (exchanged for JWT) or OAuth bearer token.',
      );
    }

    const isHosted = config.supabase_url.replace(/\/$/, '') === HOSTED_SUPABASE_URL;
    const apiBase = resolveApiUrl(config.supabase_url, isHosted);
    const url = resolveApiPath(apiBase, 'change-status');

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${bearer}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        decision_id: args.decision_id,
        new_status: newStatus,
        reason: args.reason,
        // Issue #54: tell the server to scope by project membership instead
        // of the auth-resolved org. Server falls back to org-scoped when
        // absent (legacy callers).
        ...(args.project_id ? { project_id: args.project_id } : {}),
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`change-status failed (HTTP ${res.status}): ${body}`);
    }

    const result = (await res.json()) as LifecycleStatusChange;

    // -----------------------------------------------------------------------
    // T012: Proposed workflow — explicit audit trail and push notifications
    // -----------------------------------------------------------------------

    const wasProposed = oldDecision?.status === 'proposed' || result.old_status === 'proposed';

    if (wasProposed) {
      try {
        const auditAction = args.action === 'promote' ? 'decision_promoted' : 'decision_deprecated';
        const auditPayload = buildAuditPayload(
          auditAction,
          'decision',
          args.decision_id,
          config.member_id || 'unknown',
          config.org_id,
          {
            projectId: oldDecision?.project_id ?? null,
            previousState: { status: 'proposed' },
            newState: {
              status: newStatus,
              promoted_from: 'proposed',
            },
            reason: args.reason,
          },
        );
        await createAuditEntry(supabase, auditPayload);
      } catch {
        // Audit failures are non-fatal
      }

      // Build push notification for proposed workflow transitions
      try {
        const summary = oldDecision?.summary || oldDecision?.detail?.substring(0, 100) || 'Decision';
        if (args.action === 'promote') {
          const _event = buildProposedPromotedEvent(
            config.author_name,
            summary,
            args.decision_id,
          );
          // Channel push wired in serve command
        } else {
          const _event = buildProposedRejectedEvent(
            config.author_name,
            summary,
            args.decision_id,
            args.reason,
          );
          // Channel push wired in serve command
        }
      } catch {
        // Channel push is best-effort
      }
    }

    return {
      decision_id: result.decision_id,
      old_status: result.old_status,
      new_status: result.new_status,
      changed_by: result.changed_by || config.author_name,
      flagged_dependents: result.flagged_dependents || [],
    };
  } catch (err) {
    // Offline fallback: cannot change status without the server
    throw new Error(
      `Cloud unavailable. Cannot ${args.action} decision offline. ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

async function getHistory(
  supabase: ReturnType<typeof getSupabaseClient>,
  decisionId: string,
): Promise<LifecycleHistoryResponse> {
  try {
    const { data, error } = await supabase.rpc('get_decision_history', {
      p_decision_id: decisionId,
    });

    if (error) {
      throw new Error(`get_decision_history failed: ${error.message}`);
    }

    const rows = (data || []) as Array<{
      from_status: DecisionStatus;
      to_status: DecisionStatus;
      changed_by: string;
      reason: string | null;
      changed_at: string;
    }>;

    // Get current status from the decision itself
    const { data: decision, error: decError } = await supabase
      .from('decisions')
      .select('status')
      .eq('id', decisionId)
      .single();

    if (decError) {
      throw new Error(`Decision not found: ${decError.message}`);
    }

    const history: LifecycleHistoryEntry[] = rows.map((row) => ({
      from: row.from_status,
      to: row.to_status,
      by: row.changed_by,
      reason: row.reason,
      at: row.changed_at,
    }));

    return {
      decision_id: decisionId,
      current_status: (decision as { status: DecisionStatus }).status,
      history,
    };
  } catch (err) {
    // Offline fallback for history
    throw new Error(
      `Cloud unavailable. Cannot fetch history offline. ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// T043: Pin / Unpin (US5)
// ---------------------------------------------------------------------------

async function handlePinUnpin(
  supabase: ReturnType<typeof getSupabaseClient>,
  orgId: string,
  decisionId: string,
  pinned: boolean,
  authorName: string,
  memberId?: string | null,
  projectId?: string,
): Promise<LifecyclePinResponse> {
  // Pull project_id back from the row we're touching so the audit row lands
  // scoped to the right project. Without this, project-scoped Recent Activity
  // never surfaces pin/unpin events.
  //
  // Issue #54: when caller supplies `projectId`, scope the UPDATE by it
  // instead of `org_id` — the row may live in a different org than the
  // auth-resolved one. Membership has already been verified at the
  // handler entrypoint.
  let updateQuery = supabase
    .from('decisions')
    .update({ pinned })
    .eq('id', decisionId);
  updateQuery = projectId
    ? updateQuery.eq('project_id', projectId)
    : updateQuery.eq('org_id', orgId);
  const { data: updated, error } = await updateQuery
    .select('project_id')
    .single();

  if (error) {
    throw new Error(`Failed to ${pinned ? 'pin' : 'unpin'} decision: ${error.message}`);
  }

  const pinnedProjectId = (updated as { project_id?: string | null } | null)?.project_id ?? null;

  // Audit trail (best-effort)
  try {
    const auditPayload = buildAuditPayload(
      pinned ? 'decision_pinned' : 'decision_unpinned',
      'decision',
      decisionId,
      memberId || 'unknown',
      orgId,
      { projectId: pinnedProjectId, newState: { pinned } },
    );
    await createAuditEntry(supabase, auditPayload);
  } catch {
    // Audit failures are non-fatal
  }

  return {
    decision_id: decisionId,
    pinned,
    changed_by: authorName,
  };
}
