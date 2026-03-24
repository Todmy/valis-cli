/**
 * T017: Supabase Realtime subscription for cross-session push.
 *
 * Subscribes to postgres_changes (INSERT + UPDATE) on the `decisions` table
 * filtered by org_id. Parses payloads, deduplicates against local stores,
 * and emits channel events for the local MCP session.
 *
 * Key constraint: Supabase Realtime does NOT buffer messages (FR-008).
 * On reconnect a fresh subscribe is issued — no backlog is delivered.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Decision, DecisionStatus } from '../types.js';
import {
  buildRemoteDecisionEvent,
  buildProposedDecisionEvent,
  buildDeprecationEvent,
  type ChannelEvent,
} from '../channel/push.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RealtimeStatus = 'connected' | 'disconnected' | 'degraded';

export interface RealtimeSubscription {
  /** Current connection status. */
  status: RealtimeStatus;
  /** Unsubscribe and close the channel. */
  unsubscribe: () => Promise<void>;
}

export interface SubscribeOptions {
  /** Local author name — used for dedup (skip events authored by this session). */
  localAuthor: string;
  /** Called for each actionable realtime event. */
  onEvent: (event: ChannelEvent) => void;
  /** Called when the subscription encounters an error. */
  onError: (error: Error) => void;
  /** Called when connection status changes. */
  onStatusChange?: (status: RealtimeStatus) => void;
}

// ---------------------------------------------------------------------------
// Dedup window
// ---------------------------------------------------------------------------

/** Window in ms to suppress echo events from the local author. */
const DEDUP_WINDOW_MS = 5_000;

/**
 * Simple echo-suppression: if the decision's author matches the local author
 * and the decision was created within the dedup window, skip the push.
 */
function isLocalEcho(decision: Partial<Decision>, localAuthor: string): boolean {
  if (decision.author !== localAuthor) return false;
  if (!decision.created_at) return false;

  const createdAt = new Date(decision.created_at).getTime();
  return Date.now() - createdAt < DEDUP_WINDOW_MS;
}

// ---------------------------------------------------------------------------
// Payload handling
// ---------------------------------------------------------------------------

/**
 * Parse and handle an INSERT event from Supabase Realtime.
 * Returns a ChannelEvent or null if the event should be suppressed.
 */
export function handleInsertEvent(
  payload: { new: Record<string, unknown> },
  localAuthor: string,
): ChannelEvent | null {
  const row = payload.new as unknown as Partial<Decision>;
  if (!row.id || !row.detail) return null;

  // Dedup: skip if this is an echo of our own store
  if (isLocalEcho(row, localAuthor)) return null;

  // T015: Proposed decisions get a distinct push event with proposed label
  if (row.status === 'proposed') {
    return buildProposedDecisionEvent(
      row.author ?? 'unknown',
      row.type ?? 'decision',
      row.summary ?? row.detail.substring(0, 100),
    );
  }

  return buildRemoteDecisionEvent({
    author: row.author ?? 'unknown',
    type: row.type ?? 'decision',
    summary: row.summary ?? row.detail.substring(0, 100),
    detail: row.detail,
  });
}

/**
 * Parse and handle an UPDATE event from Supabase Realtime.
 * We care about status transitions to deprecated/superseded.
 * Returns a ChannelEvent or null if the event is not actionable.
 */
export function handleUpdateEvent(
  payload: { new: Record<string, unknown>; old: Record<string, unknown> },
  localAuthor: string,
): ChannelEvent | null {
  const row = payload.new as unknown as Partial<Decision>;
  const oldRow = payload.old as unknown as Partial<Decision>;
  if (!row.id || !row.detail) return null;

  // Dedup: skip echo
  if (row.status_changed_by === localAuthor) {
    const changedAt = row.status_changed_at
      ? new Date(row.status_changed_at).getTime()
      : 0;
    if (Date.now() - changedAt < DEDUP_WINDOW_MS) return null;
  }

  // Only emit deprecation/supersession events
  const newStatus = row.status as DecisionStatus | undefined;
  const oldStatus = oldRow.status as DecisionStatus | undefined;

  if (
    newStatus &&
    (newStatus === 'deprecated' || newStatus === 'superseded') &&
    newStatus !== oldStatus
  ) {
    return buildDeprecationEvent(
      {
        author: row.author ?? 'unknown',
        summary: row.summary ?? row.detail.substring(0, 100),
        detail: row.detail,
        status: newStatus,
        status_reason: (row.status_reason as string) ?? undefined,
      },
      row.status_changed_by ?? 'unknown',
    );
  }

  return null;
}

// ---------------------------------------------------------------------------
// Subscription
// ---------------------------------------------------------------------------

/**
 * Subscribe to Supabase Realtime postgres_changes for an org's decisions.
 *
 * Listens for INSERT (new decisions from other sessions) and UPDATE
 * (status changes like deprecation/supersession).
 *
 * Returns a RealtimeSubscription object with status and unsubscribe().
 */
export function subscribeToOrg(
  supabase: SupabaseClient,
  orgId: string,
  options: SubscribeOptions,
): RealtimeSubscription {
  const { localAuthor, onEvent, onError, onStatusChange } = options;

  const subscription: RealtimeSubscription = {
    status: 'disconnected',
    unsubscribe: async () => {
      /* replaced below */
    },
  };

  const setStatus = (status: RealtimeStatus) => {
    subscription.status = status;
    onStatusChange?.(status);
  };

  const channel = supabase
    .channel(`org:${orgId}`)
    .on(
      'postgres_changes',
      {
        event: 'INSERT',
        schema: 'public',
        table: 'decisions',
        filter: `org_id=eq.${orgId}`,
      },
      (payload) => {
        try {
          const event = handleInsertEvent(
            payload as { new: Record<string, unknown> },
            localAuthor,
          );
          if (event) onEvent(event);
        } catch (err) {
          onError(err instanceof Error ? err : new Error(String(err)));
        }
      },
    )
    .on(
      'postgres_changes',
      {
        event: 'UPDATE',
        schema: 'public',
        table: 'decisions',
        filter: `org_id=eq.${orgId}`,
      },
      (payload) => {
        try {
          const event = handleUpdateEvent(
            payload as {
              new: Record<string, unknown>;
              old: Record<string, unknown>;
            },
            localAuthor,
          );
          if (event) onEvent(event);
        } catch (err) {
          onError(err instanceof Error ? err : new Error(String(err)));
        }
      },
    )
    .subscribe((status, err) => {
      switch (status) {
        case 'SUBSCRIBED':
          setStatus('connected');
          break;
        case 'CHANNEL_ERROR':
          setStatus('degraded');
          onError(err ?? new Error('Realtime channel error'));
          break;
        case 'TIMED_OUT':
          setStatus('degraded');
          onError(new Error('Realtime subscription timed out'));
          break;
        case 'CLOSED':
          setStatus('disconnected');
          break;
      }
    });

  subscription.unsubscribe = async () => {
    setStatus('disconnected');
    await supabase.removeChannel(channel);
  };

  return subscription;
}
