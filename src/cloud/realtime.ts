/**
 * T017: Supabase Realtime subscription for cross-session push.
 * T029: Project-scoped Realtime — filter by project_id instead of org_id.
 *
 * Subscribes to postgres_changes (INSERT + UPDATE) on the `decisions` table
 * filtered by project_id (or org_id as fallback when no project configured).
 * Parses payloads, deduplicates against local stores, and emits channel
 * events for the local MCP session.
 *
 * Key constraint: Supabase Realtime does NOT buffer messages (FR-008).
 * On reconnect a fresh subscribe is issued — no backlog is delivered.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Decision, DecisionStatus } from '../types.js';
import {
  buildRemoteDecisionEvent,
  buildDeprecationEvent,
  buildProposedDecisionEvent,
  buildProposedPromotedEvent,
  buildProposedRejectedEvent,
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
 *
 * T015: When the inserted decision has status 'proposed', emit a
 * dedicated proposed event so other sessions are alerted about the
 * new proposal awaiting review.
 */
export function handleInsertEvent(
  payload: { new: Record<string, unknown> },
  localAuthor: string,
): ChannelEvent | null {
  const row = payload.new as unknown as Partial<Decision>;
  if (!row.id || !row.detail) return null;

  // Dedup: skip if this is an echo of our own store
  if (isLocalEcho(row, localAuthor)) return null;

  // T015: Proposed decisions get a dedicated push event with proposed label
  if (row.status === 'proposed') {
    return buildProposedDecisionEvent(
      row.author ?? 'unknown',
      row.type ?? 'decision',
      row.summary ?? row.detail.substring(0, 100),
      row.id,
    );
  }

  return buildRemoteDecisionEvent({
    author: row.author ?? 'unknown',
    type: row.type ?? 'decision',
    summary: row.summary ?? row.detail.substring(0, 100),
    detail: row.detail,
    project_id: (row.project_id as string) ?? undefined,
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

  // Emit events for status transitions
  const newStatus = row.status as DecisionStatus | undefined;
  const oldStatus = oldRow.status as DecisionStatus | undefined;

  if (newStatus && newStatus !== oldStatus) {
    const changedBy = row.status_changed_by ?? 'unknown';
    const summary = row.summary ?? row.detail.substring(0, 100);

    // T015: Proposed workflow transitions — promote or reject
    if (oldStatus === 'proposed' && newStatus === 'active') {
      return buildProposedPromotedEvent(changedBy, summary, row.id!);
    }

    if (oldStatus === 'proposed' && newStatus === 'deprecated') {
      return buildProposedRejectedEvent(
        changedBy,
        summary,
        row.id!,
        (row.status_reason as string) ?? undefined,
      );
    }

    // Deprecation/supersession events
    if (newStatus === 'deprecated' || newStatus === 'superseded') {
      return buildDeprecationEvent(
        {
          author: row.author ?? 'unknown',
          summary,
          detail: row.detail,
          status: newStatus,
          status_reason: (row.status_reason as string) ?? undefined,
          project_id: (row.project_id as string) ?? undefined,
        },
        changedBy,
      );
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Internal helper — builds a subscription on a given channel/filter pair
// ---------------------------------------------------------------------------

function buildSubscription(
  supabase: SupabaseClient,
  channelName: string,
  filterColumn: string,
  filterValue: string,
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
    .channel(channelName)
    .on(
      'postgres_changes',
      {
        event: 'INSERT',
        schema: 'public',
        table: 'decisions',
        filter: `${filterColumn}=eq.${filterValue}`,
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
        filter: `${filterColumn}=eq.${filterValue}`,
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

// ---------------------------------------------------------------------------
// Subscription
// ---------------------------------------------------------------------------

/**
 * T029: Subscribe to Supabase Realtime postgres_changes scoped to a project.
 *
 * Uses channel name `project:${projectId}` and filters by
 * `project_id=eq.${projectId}`.
 *
 * Returns a RealtimeSubscription object with status and unsubscribe().
 */
export function subscribeToProject(
  supabase: SupabaseClient,
  projectId: string,
  options: SubscribeOptions,
): RealtimeSubscription {
  return buildSubscription(
    supabase,
    `project:${projectId}`,
    'project_id',
    projectId,
    options,
  );
}

/**
 * Subscribe to Supabase Realtime postgres_changes for an org's decisions.
 *
 * Kept for backward compatibility / migration fallback when no project_id
 * is configured. Prefer subscribeToProject when a project is available.
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
  return buildSubscription(
    supabase,
    `org:${orgId}`,
    'org_id',
    orgId,
    options,
  );
}

/**
 * T029: Smart subscribe — uses project-scoped channel when a projectId is
 * provided, falls back to org-level subscription during migration.
 */
export function subscribe(
  supabase: SupabaseClient,
  orgId: string,
  projectId: string | undefined,
  options: SubscribeOptions,
): RealtimeSubscription {
  if (projectId) {
    return subscribeToProject(supabase, projectId, options);
  }
  return subscribeToOrg(supabase, orgId, options);
}
