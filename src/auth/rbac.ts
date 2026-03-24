/**
 * T005 + T014: Role-Based Access Control (RBAC) module.
 *
 * Pure functions — no side effects, no external imports except types.
 *
 * Permission rules (from spec FR-001, FR-013):
 *   - Any member: store, search, deprecate, promote
 *   - Admin only: rotate keys, revoke members, manage org settings
 *   - Admin OR original author: supersede (via replaces)
 *
 * Project-level permission rules (T014 — US2):
 *   - project_member: store, search, deprecate, promote within project
 *   - project_admin: above + supersede, manage project members, rotate project invite
 *   - org admin: implicit access to all projects, all project_admin permissions
 */

import type { MemberRole, AuditAction, ProjectRole } from '../types.js';

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
  'decision_pinned',
  'decision_unpinned',
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
 * Only admins may pin or unpin decisions (exempt from confidence decay).
 */
export function canPin(memberRole: string): boolean {
  return memberRole === 'admin';
}

/**
 * Check whether a role may perform a given status transition.
 *
 * - deprecate / promote: any member
 * - supersede: admin + original author (caller must additionally verify
 *   authorship via {@link canSupersede})
 * - pin / unpin: admin only
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
    case 'pin':
    case 'unpin':
      return memberRole === 'admin';
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// Project-level permission checks (T014 — US2)
// ---------------------------------------------------------------------------

/**
 * Resolve the effective project role from JWT claims.
 *
 * Org admins have implicit project_admin access to all projects.
 * If a project_role is present in the JWT claims, it is used directly.
 * Otherwise, org admins get project_admin and everyone else gets undefined.
 */
export function resolveProjectRole(
  orgRole: MemberRole,
  projectRole?: ProjectRole | null,
): ProjectRole | undefined {
  // Org admins always have project_admin-equivalent access
  if (orgRole === 'admin') return 'project_admin';
  // Explicit project role from JWT
  if (projectRole) return projectRole;
  // No project access
  return undefined;
}

/**
 * Check whether a member can access a specific project.
 *
 * Access is granted when:
 *   - The member is in project_members for this project, OR
 *   - The member is an org admin (implicit access to all projects).
 *
 * @param orgRole - The member's org-level role ('admin' | 'member')
 * @param projectRole - The project-level role from JWT claims (undefined = not a project member)
 */
export function canAccessProject(
  orgRole: MemberRole,
  projectRole?: ProjectRole | null,
): boolean {
  // Org admins have implicit access to all projects
  if (orgRole === 'admin') return true;
  // Explicit project membership
  return projectRole != null;
}

/**
 * Check whether a member can manage project members (add/remove).
 *
 * Allowed when:
 *   - The member has project_admin role, OR
 *   - The member is an org admin.
 */
export function canManageProjectMembers(
  orgRole: MemberRole,
  projectRole?: ProjectRole | null,
): boolean {
  if (orgRole === 'admin') return true;
  return projectRole === 'project_admin';
}

/**
 * Check whether a member can rotate a project's invite code.
 *
 * Allowed when:
 *   - The member has project_admin role, OR
 *   - The member is an org admin.
 */
export function canRotateProjectInvite(
  orgRole: MemberRole,
  projectRole?: ProjectRole | null,
): boolean {
  if (orgRole === 'admin') return true;
  return projectRole === 'project_admin';
}

/**
 * Check whether a role may perform a given status transition within a project.
 *
 * Uses the effective project role rather than the org role:
 *   - project_member: can deprecate, promote
 *   - project_admin or org admin: can also supersede
 *   - pin / unpin: org admin only (org-level privilege)
 *
 * @param orgRole - The member's org-level role
 * @param projectRole - The project-level role from JWT claims
 * @param transition - The status transition to check
 */
export function canChangeStatusInProject(
  orgRole: MemberRole,
  projectRole: ProjectRole | undefined | null,
  transition: string,
): boolean {
  const effectiveRole = resolveProjectRole(orgRole, projectRole);
  if (!effectiveRole) return false; // no project access at all

  switch (transition) {
    case 'deprecate':
    case 'promote':
      return true; // any project member
    case 'supersede':
      // project_admin or org admin
      return orgRole === 'admin' || effectiveRole === 'project_admin';
    case 'pin':
    case 'unpin':
      // Org admin only — pin/unpin is an org-level privilege
      return orgRole === 'admin';
    default:
      return false;
  }
}
