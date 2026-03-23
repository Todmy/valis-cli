import type { DecisionType } from '../types.js';

export interface ChannelEvent {
  source: string;
  event: string;
  content: string;
  meta: Record<string, string>;
}

export function buildCaptureReminder(): ChannelEvent {
  return {
    source: 'teamind',
    event: 'capture_reminder',
    content:
      'Review your recent work. If any decisions, constraints, patterns, or lessons were established, store them via teamind_store with type, summary, and affects.',
    meta: {
      event: 'capture_reminder',
    },
  };
}

export function buildNewDecisionEvent(
  author: string,
  type: DecisionType,
  summary: string,
): ChannelEvent {
  return {
    source: 'teamind',
    event: 'new_decision',
    content: summary,
    meta: {
      event: 'new_decision',
      author,
      type,
    },
  };
}
