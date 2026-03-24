import type { DecisionType, DecisionStatus } from '../types.js';

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

// ---------------------------------------------------------------------------
// T015: Proposed decision push event
// ---------------------------------------------------------------------------

/**
 * Build a channel event when a new proposed decision is stored.
 * Distinguished from regular new_decision by `status: proposed` in meta.
 */
export function buildProposedDecisionEvent(
  author: string,
  type: DecisionType,
  summary: string,
): ChannelEvent {
  return {
    source: 'teamind',
    event: 'new_decision',
    content: `[Proposed] ${summary}`,
    meta: {
      event: 'new_decision',
      author,
      type,
      status: 'proposed',
    },
  };
}

// ---------------------------------------------------------------------------
// T018: Cross-session push event builders
// ---------------------------------------------------------------------------

/** Input for buildRemoteDecisionEvent — subset of Decision fields. */
export interface RemoteDecisionInput {
  author: string;
  type: DecisionType;
  summary: string;
  detail: string;
}

/**
 * Build a channel event for a decision received via Supabase Realtime
 * (i.e., stored by a different session).
 *
 * Distinguished from local push by `origin: remote` in meta.
 */
export function buildRemoteDecisionEvent(decision: RemoteDecisionInput): ChannelEvent {
  return {
    source: 'teamind',
    event: 'new_decision',
    content: decision.summary || decision.detail.substring(0, 100),
    meta: {
      event: 'new_decision',
      author: decision.author,
      type: decision.type,
      origin: 'remote',
    },
  };
}

/** Input for buildDeprecationEvent — subset of Decision fields. */
export interface DeprecationInput {
  author: string;
  summary: string;
  detail: string;
  status: DecisionStatus;
  status_reason?: string;
}

/**
 * Build a channel event for a decision that has been deprecated or
 * superseded by another session.
 */
export function buildDeprecationEvent(
  decision: DeprecationInput,
  changedBy: string,
): ChannelEvent {
  const reason = decision.status_reason
    ? `\nReason: ${decision.status_reason}`
    : '';
  const label = decision.status === 'superseded' ? 'superseded' : 'deprecated';

  return {
    source: 'teamind',
    event: 'decision_deprecated',
    content:
      `Decision ${label} by ${changedBy}: "${decision.summary || decision.detail.substring(0, 100)}"${reason}`,
    meta: {
      event: 'decision_deprecated',
      author: changedBy,
      type: 'info',
      status: decision.status,
    },
  };
}

/** Input for buildContradictionEvent. */
export interface ContradictionInput {
  author: string;
  summary: string;
}

/**
 * Build a channel event when a contradiction is detected between two
 * decisions.
 */
export function buildContradictionEvent(
  decisionA: ContradictionInput,
  decisionB: ContradictionInput,
  overlapAreas: string[],
): ChannelEvent {
  const areas = overlapAreas.join(', ');
  return {
    source: 'teamind',
    event: 'contradiction_detected',
    content:
      `Potential contradiction: "${decisionA.summary}" by ${decisionA.author} ` +
      `conflicts with "${decisionB.summary}" by ${decisionB.author} (area: ${areas}). ` +
      `Both remain active — resolve via deprecation or replacement.`,
    meta: {
      event: 'contradiction_detected',
      author: decisionA.author,
      type: 'warning',
    },
  };
}
