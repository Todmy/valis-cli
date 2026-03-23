/**
 * T005: Role-Based Access Control (RBAC) module.
 *
 * Pure functions — no side effects, no external imports except types.
 *
 * Permission rules (from spec FR-001, FR-013):
 *   - Any member: store, search, deprecate, promote
 *   - Admin only: rotate keys, revoke members, manage org settings
 *   - Admin OR original author: supersede (via replaces)
 */

import type { MemberRole, AuditAction } from '../types.js';

// ---------------------------------------------------------------------------
// Actions any authenticated member may perform
// ---------------------------------------------------------------------------

const MEMBER_ACTIONS: ReadonlySet<string> = new Set<string>([
  'decision_stored',
  'decision_deprecated',
  'decision_promoted',
  'decision_depends_added',
  'member_joined',
  'contradiction_detected',
  'contradiction_resolved',
  'search',
]);

// ---------------------------------------------------------------------------
// Actions restricted to admin role
// ---------------------------------------------------------------------------

const ADMIN_ONLY_ACTIONS: ReadonlySet<string> = new Set<string>([
  'key_rotated',
  'org_key_rotated',
  'member_revoked',
]);

// ---------------------------------------------------------------------------
// Actions requiring admin OR original authorship
// ---------------------------------------------------------------------------

const AUTHOR_OR_ADMIN_ACTIONS: ReadonlySet<string> = new Set<string>([
  'decision_superseded',
]);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Check whether a given role is allowed to perform an action.
 *
 * For actions that additionally depend on authorship (e.g. supersede),
 * this returns `true` for admins. For regular members use
 * {@link canSupersede} which also accepts the author check.
 */
export function checkPermission(memberRole: string, action: string): boolean {
  if (MEMBER_ACTIONS.has(action)) {
    return true; // any authenticated member
  }

  if (ADMIN_ONLY_ACTIONS.has(action)) {
    return memberRole === 'admin';
  }

  if (AUTHOR_OR_ADMIN_ACTIONS.has(action)) {
    // Admin always allowed; for members, caller must also verify authorship
    // via canSupersede(). Returning true for admin, false for member here
    // because we cannot check authorship without context.
    return memberRole === 'admin';
  }

  // Unknown action — deny by default
  return false;
}

/**
 * Determine whether a member may supersede (replace) a decision.
 *
 * Allowed when:
 *   - The member is an admin, OR
 *   - The member is the original author of the decision being replaced.
 */
export function canSupersede(
  memberRole: string,
  memberName: string,
  decisionAuthor: string,
): boolean {
  if (memberRole === 'admin') return true;
  return memberName === decisionAuthor;
}

/**
 * Only admins may rotate API keys (org-level or member-level).
 */
export function canRotateKey(memberRole: string): boolean {
  return memberRole === 'admin';
}

/**
 * Only admins may revoke member access.
 */
export function canRevokeMember(memberRole: string): boolean {
  return memberRole === 'admin';
}

/**
 * Check whether a role may perform a given status transition.
 *
 * - deprecate / promote: any member
 * - supersede: admin + original author (caller must additionally verify
 *   authorship via {@link canSupersede})
 */
export function canChangeStatus(
  memberRole: string,
  transition: string,
): boolean {
  switch (transition) {
    case 'deprecate':
    case 'promote':
      return true; // any authenticated member
    case 'supersede':
      return memberRole === 'admin';
    default:
      return false;
  }
}
