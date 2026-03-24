import { loadConfig } from '../../config/store.js';
import { getSupabaseClient, getDecisionById } from '../../cloud/supabase.js';
import { buildAuditPayload, createAuditEntry } from '../../auth/audit.js';
import { buildProposedPromotedEvent, buildProposedRejectedEvent } from '../../channel/push.js';
import type {
  LifecycleArgs,
  LifecycleResponse,
  LifecycleStatusChange,
  LifecycleHistoryResponse,
  LifecycleHistoryEntry,
  LifecyclePinResponse,
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

  // -------------------------------------------------------------------------
  // T043: Pin / Unpin (US5)
  // -------------------------------------------------------------------------

  if (args.action === 'pin' || args.action === 'unpin') {
    return await handlePinUnpin(supabase, config.org_id, args.decision_id, args.action === 'pin', config.author_name, config.member_id);
  }

  // -------------------------------------------------------------------------
  // T012: Resolve target status for proposed workflow audit trail
  // -------------------------------------------------------------------------

  // deprecate or promote
  const newStatus: DecisionStatus = args.action === 'deprecate' ? 'deprecated' : 'active';

  // Fetch the current decision to know old_status for audit trail
  let oldDecision: { status: DecisionStatus; summary: string | null; detail: string; author: string } | null = null;
  try {
    const fetched = await getDecisionById(supabase, config.org_id, args.decision_id);
    if (fetched) {
      oldDecision = {
        status: fetched.status,
        summary: fetched.summary,
        detail: fetched.detail,
        author: fetched.author,
      };
    }
  } catch {
    // Best-effort — the change-status edge function will validate
  }

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
): Promise<LifecyclePinResponse> {
  const { error } = await supabase
    .from('decisions')
    .update({ pinned })
    .eq('id', decisionId)
    .eq('org_id', orgId);

  if (error) {
    throw new Error(`Failed to ${pinned ? 'pin' : 'unpin'} decision: ${error.message}`);
  }

  // Audit trail (best-effort)
  try {
    const auditPayload = buildAuditPayload(
      pinned ? 'decision_pinned' : 'decision_unpinned',
      'decision',
      decisionId,
      memberId || 'unknown',
      orgId,
      { newState: { pinned } },
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
