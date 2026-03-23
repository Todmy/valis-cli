import { loadConfig } from '../../config/store.js';
import { getSupabaseClient } from '../../cloud/supabase.js';
import type {
  LifecycleArgs,
  LifecycleResponse,
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
