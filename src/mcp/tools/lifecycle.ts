import { loadConfig } from '../../config/store.js';
import { getSupabaseClient, pinDecision, getDecisionById } from '../../cloud/supabase.js';
import { getQdrantClient, updatePinnedPayload } from '../../cloud/qdrant.js';
import { buildAuditPayload, createAuditEntry } from '../../auth/audit.js';
import { canPin } from '../../auth/rbac.js';
import { getToken } from '../../auth/jwt.js';
import type {
  LifecycleArgs,
  LifecycleResponse,
  LifecyclePinResponse,
  LifecycleStatusChange,
  LifecycleHistoryResponse,
  LifecycleHistoryEntry,
  DecisionStatus,
} from '../../types.js';

export async function handleLifecycle(args: LifecycleArgs): Promise<LifecycleResponse> {
  const config = await loadConfig();
  if (!config) {
    throw new Error('Not configured. Run `teamind init` first.');
  }

  const supabase = getSupabaseClient(config.supabase_url, config.supabase_service_role_key);

  if (args.action === 'history') {
    return await getHistory(supabase, args.decision_id);
  }

  // T043: pin/unpin — admin-only
  if (args.action === 'pin' || args.action === 'unpin') {
    return await handlePinUnpin(supabase, config, args);
  }

  // deprecate or promote
  const newStatus: DecisionStatus = args.action === 'deprecate' ? 'deprecated' : 'active';

  try {
    const { data, error } = await supabase.functions.invoke('change-status', {
      body: {
        decision_id: args.decision_id,
        new_status: newStatus,
        reason: args.reason,
      },
    });

    if (error) {
      throw new Error(`change-status failed: ${error.message}`);
    }

    const result = data as LifecycleStatusChange;
    const changedBy = result.changed_by || config.author_name;

    // T012: Audit trail for proposed → active (promote) and proposed → deprecated (reject)
    if (result.old_status === 'proposed') {
      const auditAction = newStatus === 'active' ? 'decision_promoted' : 'decision_deprecated';
      try {
        const auditPayload = buildAuditPayload(
          auditAction,
          'decision',
          args.decision_id,
          config.member_id || 'unknown',
          config.org_id,
          {
            previousState: { status: 'proposed' },
            newState: { status: newStatus },
            reason: args.reason,
          },
        );
        await createAuditEntry(supabase, auditPayload);
      } catch {
        // Audit failure is non-fatal
      }
    }

    return {
      decision_id: result.decision_id,
      old_status: result.old_status,
      new_status: result.new_status,
      changed_by: changedBy,
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

/**
 * Handle pin/unpin lifecycle action (T043).
 *
 * Admin-only: uses RBAC canPin check.
 * Updates both Postgres (pinned column) and Qdrant (pinned payload field).
 * Creates an audit entry.
 */
async function handlePinUnpin(
  supabase: ReturnType<typeof getSupabaseClient>,
  config: import('../../types.js').TeamindConfig,
  args: LifecycleArgs,
): Promise<LifecyclePinResponse> {
  const pinned = args.action === 'pin';
  const auditAction = pinned ? 'decision_pinned' : 'decision_unpinned';

  // Resolve member role — JWT mode uses token cache, legacy defaults to 'member'
  let memberRole = 'member';
  if (config.auth_mode === 'jwt' && config.member_api_key) {
    const cache = await getToken(config.supabase_url, config.member_api_key);
    if (cache) memberRole = cache.role;
  }

  // RBAC check — pin/unpin is admin-only
  if (!canPin(memberRole)) {
    throw new Error(`Permission denied: ${args.action} requires admin role.`);
  }

  // Verify decision exists
  const existing = await getDecisionById(supabase, config.org_id, args.decision_id);
  if (!existing) {
    throw new Error(`Decision not found: ${args.decision_id}`);
  }

  const previousPinned = existing.pinned ?? false;
  if (previousPinned === pinned) {
    // Already in desired state — return idempotently
    return {
      decision_id: args.decision_id,
      pinned,
      changed_by: config.author_name,
    };
  }

  try {
    // Update Postgres
    await pinDecision(supabase, config.org_id, args.decision_id, pinned);

    // Update Qdrant payload
    try {
      const qdrant = getQdrantClient(config.qdrant_url, config.qdrant_api_key);
      await updatePinnedPayload(qdrant, args.decision_id, pinned);
    } catch {
      // Qdrant update failure is non-fatal — Postgres is source of truth
      console.error(`[teamind] Qdrant pinned payload update failed for ${args.decision_id}`);
    }

    // Audit entry
    try {
      const auditPayload = buildAuditPayload(
        auditAction,
        'decision',
        args.decision_id,
        config.member_id || 'unknown',
        config.org_id,
        {
          previousState: { pinned: previousPinned },
          newState: { pinned },
          reason: args.reason,
        },
      );
      await createAuditEntry(supabase, auditPayload);
    } catch {
      // Audit failure is non-fatal
    }

    return {
      decision_id: args.decision_id,
      pinned,
      changed_by: config.author_name,
    };
  } catch (err) {
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
