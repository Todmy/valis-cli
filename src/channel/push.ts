import type { DecisionType, DecisionStatus } from '../types.js';

export interface ChannelEvent {
  source: string;
  event: string;
  content: string;
  meta: Record<string, string>;
}

export function buildCaptureReminder(): ChannelEvent {
  return {
    source: 'valis',
    event: 'capture_reminder',
    content:
      'Review your recent work. If any decisions, constraints, patterns, or lessons were established, store them via valis_store with type, summary, and affects.',
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
    source: 'valis',
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
// T018: Cross-session push event builders
// T031: Project context in push events (project_id + project_name)
// ---------------------------------------------------------------------------

/** Input for buildRemoteDecisionEvent — subset of Decision fields. */
export interface RemoteDecisionInput {
  author: string;
  type: DecisionType;
  summary: string;
  detail: string;
  /** T031: project_id from the decision payload. */
  project_id?: string;
  /** T031: project_name for display in push notification. */
  project_name?: string;
}

/**
 * Build a channel event for a decision received via Supabase Realtime
 * (i.e., stored by a different session).
 *
 * Distinguished from local push by `origin: remote` in meta.
 * T031: Includes project_id and project_name when available.
 */
export function buildRemoteDecisionEvent(decision: RemoteDecisionInput): ChannelEvent {
  const projectPrefix = decision.project_name
    ? `[${decision.project_name}] `
    : '';
  const meta: Record<string, string> = {
    event: 'new_decision',
    author: decision.author,
    type: decision.type,
    origin: 'remote',
  };
  if (decision.project_id) meta.project_id = decision.project_id;
  if (decision.project_name) meta.project_name = decision.project_name;

  return {
    source: 'valis',
    event: 'new_decision',
    content: `${projectPrefix}${decision.summary || decision.detail.substring(0, 100)}`,
    meta,
  };
}

/** Input for buildDeprecationEvent — subset of Decision fields. */
export interface DeprecationInput {
  author: string;
  summary: string;
  detail: string;
  status: DecisionStatus;
  status_reason?: string;
  /** T031: project_id from the decision payload. */
  project_id?: string;
}

/**
 * Build a channel event for a decision that has been deprecated or
 * superseded by another session.
 *
 * T031: Includes project_id when available.
 */
export function buildDeprecationEvent(
  decision: DeprecationInput,
  changedBy: string,
): ChannelEvent {
  const reason = decision.status_reason
    ? `\nReason: ${decision.status_reason}`
    : '';
  const label = decision.status === 'superseded' ? 'superseded' : 'deprecated';

  const meta: Record<string, string> = {
    event: 'decision_deprecated',
    author: changedBy,
    type: 'info',
    status: decision.status,
  };
  if (decision.project_id) meta.project_id = decision.project_id;

  return {
    source: 'valis',
    event: 'decision_deprecated',
    content:
      `Decision ${label} by ${changedBy}: "${decision.summary || decision.detail.substring(0, 100)}"${reason}`,
    meta,
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
 *
 * T031: Accepts optional project_id for project-scoped contradiction context.
 */
export function buildContradictionEvent(
  decisionA: ContradictionInput,
  decisionB: ContradictionInput,
  overlapAreas: string[],
  projectId?: string,
): ChannelEvent {
  const areas = overlapAreas.join(', ');
  const meta: Record<string, string> = {
    event: 'contradiction_detected',
    author: decisionA.author,
    type: 'warning',
  };
  if (projectId) meta.project_id = projectId;

  return {
    source: 'valis',
    event: 'contradiction_detected',
    content:
      `Potential contradiction: "${decisionA.summary}" by ${decisionA.author} ` +
      `conflicts with "${decisionB.summary}" by ${decisionB.author} (area: ${areas}). ` +
      `Both remain active — resolve via deprecation or replacement.`,
    meta,
  };
}

// ---------------------------------------------------------------------------
// T015: Proposed decision workflow push events (Phase 3 — US1)
// ---------------------------------------------------------------------------

/**
 * Build a channel event when a new proposed decision is stored.
 * Triggers cross-session notification so all team members see the proposal.
 */
export function buildProposedDecisionEvent(
  author: string,
  type: DecisionType,
  summary: string,
  decisionId: string,
): ChannelEvent {
  return {
    source: 'valis',
    event: 'decision_proposed',
    content:
      `New proposed decision by ${author}: "${summary}". ` +
      `Review and promote or reject via valis_lifecycle.`,
    meta: {
      event: 'decision_proposed',
      author,
      type,
      decision_id: decisionId,
      status: 'proposed',
    },
  };
}

/**
 * Build a channel event when a proposed decision is promoted to active.
 */
export function buildProposedPromotedEvent(
  promotedBy: string,
  summary: string,
  decisionId: string,
): ChannelEvent {
  return {
    source: 'valis',
    event: 'decision_promoted',
    content:
      `Proposed decision promoted to active by ${promotedBy}: "${summary}".`,
    meta: {
      event: 'decision_promoted',
      author: promotedBy,
      type: 'info',
      decision_id: decisionId,
      status: 'active',
    },
  };
}

/**
 * Build a channel event when a proposed decision is rejected (deprecated).
 */
export function buildProposedRejectedEvent(
  rejectedBy: string,
  summary: string,
  decisionId: string,
  reason?: string,
): ChannelEvent {
  const reasonSuffix = reason ? ` Reason: ${reason}` : '';
  return {
    source: 'valis',
    event: 'decision_rejected',
    content:
      `Proposed decision rejected by ${rejectedBy}: "${summary}".${reasonSuffix}`,
    meta: {
      event: 'decision_rejected',
      author: rejectedBy,
      type: 'info',
      decision_id: decisionId,
      status: 'deprecated',
    },
  };
}
