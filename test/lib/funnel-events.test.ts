import { describe, it, expect } from 'vitest';
import {
  FUNNEL_EVENT_TYPES,
  isFunnelEvent,
  type FunnelEventName,
} from '../../src/lib/funnel-events.js';

describe('funnel-events', () => {
  it('includes the canonical funnel stages required by PROD-CLOSE-PLAN', () => {
    // Update this list together with the FUNNEL_EVENT_TYPES tuple to keep the
    // canonical taxonomy from drifting silently.
    expect(FUNNEL_EVENT_TYPES).toContain('install');
    expect(FUNNEL_EVENT_TYPES).toContain('init_completed');
    expect(FUNNEL_EVENT_TYPES).toContain('first_decision_captured');
    expect(FUNNEL_EVENT_TYPES).toContain('first_decision_enforced');
    expect(FUNNEL_EVENT_TYPES).toContain('team_invited');
    expect(FUNNEL_EVENT_TYPES).toContain('second_user_joined');
    expect(FUNNEL_EVENT_TYPES).toContain('paid_upgrade');
    expect(FUNNEL_EVENT_TYPES).toContain('churned');
    expect(FUNNEL_EVENT_TYPES).toContain('agent_consulted');
  });

  it('rejects non-funnel event names', () => {
    expect(isFunnelEvent('session_started_with_context')).toBe(false);
    expect(isFunnelEvent('random_unknown_event')).toBe(false);
    expect(isFunnelEvent('')).toBe(false);
  });

  it('accepts every name in the taxonomy', () => {
    for (const name of FUNNEL_EVENT_TYPES) {
      expect(isFunnelEvent(name)).toBe(true);
    }
  });

  it('narrows the type via isFunnelEvent guard', () => {
    const candidate: string = 'install';
    if (isFunnelEvent(candidate)) {
      const narrowed: FunnelEventName = candidate;
      expect(narrowed).toBe('install');
    } else {
      throw new Error('isFunnelEvent failed for known funnel name');
    }
  });
});
