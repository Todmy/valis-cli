/**
 * T032: Tests for project-scoped Realtime subscription.
 *
 * Verifies:
 * - subscribeToProject uses project channel, not org
 * - Filter uses project_id instead of org_id
 * - subscribe() dispatches to project or org based on projectId presence
 * - Fallback to org-level when no project_id
 * - handleInsertEvent includes project_id in remote decision events
 * - handleUpdateEvent includes project_id in deprecation events
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  subscribeToProject,
  subscribeToOrg,
  subscribe,
  handleInsertEvent,
  handleUpdateEvent,
} from '../../src/cloud/realtime.js';
import type { ChannelEvent } from '../../src/channel/push.js';

// ---------------------------------------------------------------------------
// Mock Supabase client
// ---------------------------------------------------------------------------

interface MockChannel {
  on: ReturnType<typeof vi.fn>;
  subscribe: ReturnType<typeof vi.fn>;
}

function createMockSupabase() {
  const mockChannel: MockChannel = {
    on: vi.fn().mockReturnThis(),
    subscribe: vi.fn().mockImplementation((cb) => {
      // Immediately call back with SUBSCRIBED
      cb('SUBSCRIBED', null);
      return mockChannel;
    }),
  };

  const supabase = {
    channel: vi.fn().mockReturnValue(mockChannel),
    removeChannel: vi.fn().mockResolvedValue(undefined),
  };

  return { supabase, mockChannel };
}

// ---------------------------------------------------------------------------
// Tests: Channel naming and filter
// ---------------------------------------------------------------------------

describe('Project-scoped Realtime (T029)', () => {
  const projectId = '550e8400-e29b-41d4-a716-446655440000';
  const orgId = '660e8400-e29b-41d4-a716-446655440001';

  const baseOptions = {
    localAuthor: 'alice',
    onEvent: vi.fn(),
    onError: vi.fn(),
    onStatusChange: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('subscribeToProject uses project:<id> channel name', () => {
    const { supabase } = createMockSupabase();
    subscribeToProject(supabase as any, projectId, baseOptions);

    expect(supabase.channel).toHaveBeenCalledWith(`project:${projectId}`);
  });

  it('subscribeToProject filters by project_id', () => {
    const { supabase, mockChannel } = createMockSupabase();
    subscribeToProject(supabase as any, projectId, baseOptions);

    // The .on() calls should use project_id filter
    const onCalls = mockChannel.on.mock.calls;
    expect(onCalls.length).toBe(2); // INSERT + UPDATE

    const insertFilter = onCalls[0][1];
    expect(insertFilter.filter).toBe(`project_id=eq.${projectId}`);

    const updateFilter = onCalls[1][1];
    expect(updateFilter.filter).toBe(`project_id=eq.${projectId}`);
  });

  it('subscribeToOrg still uses org:<id> channel name', () => {
    const { supabase } = createMockSupabase();
    subscribeToOrg(supabase as any, orgId, baseOptions);

    expect(supabase.channel).toHaveBeenCalledWith(`org:${orgId}`);
  });

  it('subscribeToOrg filters by org_id', () => {
    const { supabase, mockChannel } = createMockSupabase();
    subscribeToOrg(supabase as any, orgId, baseOptions);

    const onCalls = mockChannel.on.mock.calls;
    const insertFilter = onCalls[0][1];
    expect(insertFilter.filter).toBe(`org_id=eq.${orgId}`);
  });

  it('subscribe() uses project channel when projectId is provided', () => {
    const { supabase } = createMockSupabase();
    subscribe(supabase as any, orgId, projectId, baseOptions);

    expect(supabase.channel).toHaveBeenCalledWith(`project:${projectId}`);
  });

  it('subscribe() falls back to org channel when projectId is undefined', () => {
    const { supabase } = createMockSupabase();
    subscribe(supabase as any, orgId, undefined, baseOptions);

    expect(supabase.channel).toHaveBeenCalledWith(`org:${orgId}`);
  });

  it('sets status to connected on SUBSCRIBED callback', () => {
    const { supabase } = createMockSupabase();
    const sub = subscribeToProject(supabase as any, projectId, baseOptions);

    expect(sub.status).toBe('connected');
    expect(baseOptions.onStatusChange).toHaveBeenCalledWith('connected');
  });

  it('unsubscribe sets status to disconnected and removes channel', async () => {
    const { supabase } = createMockSupabase();
    const sub = subscribeToProject(supabase as any, projectId, baseOptions);

    await sub.unsubscribe();

    expect(sub.status).toBe('disconnected');
    expect(supabase.removeChannel).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Tests: Event handlers include project_id (T031)
// ---------------------------------------------------------------------------

describe('Event handlers with project_id (T031)', () => {
  const projectId = '550e8400-e29b-41d4-a716-446655440000';

  it('handleInsertEvent includes project_id in remote decision event', () => {
    const payload = {
      new: {
        id: 'dec-1',
        detail: 'Use React for UI',
        summary: 'Use React',
        author: 'bob',
        type: 'decision',
        status: 'active',
        project_id: projectId,
        created_at: new Date(Date.now() - 60_000).toISOString(),
      },
    };

    const event = handleInsertEvent(payload, 'alice');
    expect(event).not.toBeNull();
    expect(event!.meta.project_id).toBe(projectId);
  });

  it('handleInsertEvent works without project_id (legacy)', () => {
    const payload = {
      new: {
        id: 'dec-2',
        detail: 'Use Vue for UI',
        summary: 'Use Vue',
        author: 'bob',
        type: 'decision',
        status: 'active',
        created_at: new Date(Date.now() - 60_000).toISOString(),
      },
    };

    const event = handleInsertEvent(payload, 'alice');
    expect(event).not.toBeNull();
    expect(event!.meta.project_id).toBeUndefined();
  });

  it('handleUpdateEvent includes project_id in deprecation event', () => {
    const payload = {
      new: {
        id: 'dec-3',
        detail: 'Use Redux for state',
        summary: 'Use Redux',
        author: 'bob',
        type: 'decision',
        status: 'deprecated',
        status_changed_by: 'carol',
        status_changed_at: new Date(Date.now() - 60_000).toISOString(),
        project_id: projectId,
      },
      old: {
        id: 'dec-3',
        status: 'active',
      },
    };

    const event = handleUpdateEvent(payload, 'alice');
    expect(event).not.toBeNull();
    expect(event!.event).toBe('decision_deprecated');
    expect(event!.meta.project_id).toBe(projectId);
  });

  it('handleUpdateEvent works without project_id (legacy)', () => {
    const payload = {
      new: {
        id: 'dec-4',
        detail: 'Use MobX',
        summary: 'Use MobX',
        author: 'bob',
        type: 'decision',
        status: 'superseded',
        status_changed_by: 'carol',
        status_changed_at: new Date(Date.now() - 60_000).toISOString(),
      },
      old: {
        id: 'dec-4',
        status: 'active',
      },
    };

    const event = handleUpdateEvent(payload, 'alice');
    expect(event).not.toBeNull();
    expect(event!.meta.project_id).toBeUndefined();
  });
});
