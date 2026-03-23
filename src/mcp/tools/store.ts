import { loadConfig } from '../../config/store.js';
import { detectSecrets } from '../../security/secrets.js';
import { isDuplicate, markAsSeen } from '../../capture/dedup.js';
import { getSupabaseClient, storeDecision } from '../../cloud/supabase.js';
import { getQdrantClient, upsertDecision } from '../../cloud/qdrant.js';
import { appendToQueue } from '../../offline/queue.js';
import { buildNewDecisionEvent } from '../../channel/push.js';
import type { RawDecision, StoreResponse, StoreErrorResponse } from '../../types.js';

interface StoreArgs {
  text: string;
  type?: 'decision' | 'constraint' | 'pattern' | 'lesson';
  summary?: string;
  affects?: string[];
  confidence?: number;
  project_id?: string;
  session_id?: string;
}

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
    const decision = await storeDecision(
      supabase,
      config.org_id,
      raw,
      config.author_name,
      'mcp_store',
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

    // Channel push: notify active sessions about new decision
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

    return {
      id: decision.id,
      status: 'stored' as const,
    };
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
