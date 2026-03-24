import { describe, it, expect } from 'vitest';
import {
  checkPermission,
  canSupersede,
  canRotateKey,
  canRevokeMember,
  canPin,
  canChangeStatus,
  canAccessProject,
  canManageProjectMembers,
  canRotateProjectInvite,
  canChangeStatusInProject,
  resolveProjectRole,
} from '../../src/auth/rbac.js';

// ---------------------------------------------------------------------------
// Org-level RBAC (existing T005 tests)
// ---------------------------------------------------------------------------

describe('Org-level RBAC', () => {
  describe('checkPermission', () => {
    it('allows any member to perform member actions', () => {
      expect(checkPermission('member', 'decision_stored')).toBe(true);
      expect(checkPermission('member', 'decision_deprecated')).toBe(true);
      expect(checkPermission('member', 'search')).toBe(true);
      expect(checkPermission('admin', 'decision_stored')).toBe(true);
    });

    it('restricts admin-only actions to admins', () => {
      expect(checkPermission('admin', 'key_rotated')).toBe(true);
      expect(checkPermission('member', 'key_rotated')).toBe(false);
      expect(checkPermission('admin', 'member_revoked')).toBe(true);
      expect(checkPermission('member', 'member_revoked')).toBe(false);
    });

    it('restricts supersede to admin (authorship requires canSupersede)', () => {
      expect(checkPermission('admin', 'decision_superseded')).toBe(true);
      expect(checkPermission('member', 'decision_superseded')).toBe(false);
    });

    it('denies unknown actions', () => {
      expect(checkPermission('admin', 'unknown_action')).toBe(false);
      expect(checkPermission('member', 'unknown_action')).toBe(false);
    });
  });

  describe('canSupersede', () => {
    it('allows admin regardless of authorship', () => {
      expect(canSupersede('admin', 'Alice', 'Bob')).toBe(true);
    });

    it('allows original author', () => {
      expect(canSupersede('member', 'Alice', 'Alice')).toBe(true);
    });

    it('denies non-admin non-author', () => {
      expect(canSupersede('member', 'Alice', 'Bob')).toBe(false);
    });
  });

  describe('canChangeStatus', () => {
    it('allows any member to deprecate or promote', () => {
      expect(canChangeStatus('member', 'deprecate')).toBe(true);
      expect(canChangeStatus('member', 'promote')).toBe(true);
    });

    it('restricts supersede/pin/unpin to admin', () => {
      expect(canChangeStatus('admin', 'supersede')).toBe(true);
      expect(canChangeStatus('member', 'supersede')).toBe(false);
      expect(canChangeStatus('admin', 'pin')).toBe(true);
      expect(canChangeStatus('member', 'pin')).toBe(false);
    });

    it('denies unknown transitions', () => {
      expect(canChangeStatus('admin', 'delete')).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// Project-level RBAC (T014/T018 — US2)
// ---------------------------------------------------------------------------

describe('Project-level RBAC (T014)', () => {
  describe('canAccessProject', () => {
    it('allows org admin access to any project (implicit access)', () => {
      expect(canAccessProject('admin', undefined)).toBe(true);
      expect(canAccessProject('admin', null)).toBe(true);
      expect(canAccessProject('admin', 'project_admin')).toBe(true);
      expect(canAccessProject('admin', 'project_member')).toBe(true);
    });

    it('allows member with project_member role', () => {
      expect(canAccessProject('member', 'project_member')).toBe(true);
    });

    it('allows member with project_admin role', () => {
      expect(canAccessProject('member', 'project_admin')).toBe(true);
    });

    it('denies member without project role', () => {
      expect(canAccessProject('member', undefined)).toBe(false);
      expect(canAccessProject('member', null)).toBe(false);
    });
  });

  describe('canManageProjectMembers', () => {
    it('allows org admin for any project', () => {
      expect(canManageProjectMembers('admin', undefined)).toBe(true);
      expect(canManageProjectMembers('admin', 'project_member')).toBe(true);
    });

    it('allows project_admin', () => {
      expect(canManageProjectMembers('member', 'project_admin')).toBe(true);
    });

    it('denies project_member', () => {
      expect(canManageProjectMembers('member', 'project_member')).toBe(false);
    });

    it('denies member with no project role', () => {
      expect(canManageProjectMembers('member', undefined)).toBe(false);
    });
  });

  describe('canRotateProjectInvite', () => {
    it('allows org admin for any project', () => {
      expect(canRotateProjectInvite('admin', undefined)).toBe(true);
    });

    it('allows project_admin', () => {
      expect(canRotateProjectInvite('member', 'project_admin')).toBe(true);
    });

    it('denies project_member', () => {
      expect(canRotateProjectInvite('member', 'project_member')).toBe(false);
    });

    it('denies member with no project role', () => {
      expect(canRotateProjectInvite('member', undefined)).toBe(false);
    });
  });

  describe('canChangeStatusInProject', () => {
    it('allows any project member to deprecate', () => {
      expect(canChangeStatusInProject('member', 'project_member', 'deprecate')).toBe(true);
      expect(canChangeStatusInProject('member', 'project_admin', 'deprecate')).toBe(true);
      expect(canChangeStatusInProject('admin', undefined, 'deprecate')).toBe(true);
    });

    it('allows any project member to promote', () => {
      expect(canChangeStatusInProject('member', 'project_member', 'promote')).toBe(true);
    });

    it('allows project_admin to supersede', () => {
      expect(canChangeStatusInProject('member', 'project_admin', 'supersede')).toBe(true);
    });

    it('allows org admin to supersede', () => {
      expect(canChangeStatusInProject('admin', undefined, 'supersede')).toBe(true);
    });

    it('denies project_member from superseding', () => {
      expect(canChangeStatusInProject('member', 'project_member', 'supersede')).toBe(false);
    });

    it('restricts pin/unpin to org admin only', () => {
      expect(canChangeStatusInProject('admin', undefined, 'pin')).toBe(true);
      expect(canChangeStatusInProject('admin', 'project_admin', 'pin')).toBe(true);
      expect(canChangeStatusInProject('member', 'project_admin', 'pin')).toBe(false);
      expect(canChangeStatusInProject('member', 'project_member', 'unpin')).toBe(false);
    });

    it('denies all transitions for non-project members', () => {
      expect(canChangeStatusInProject('member', undefined, 'deprecate')).toBe(false);
      expect(canChangeStatusInProject('member', undefined, 'promote')).toBe(false);
      expect(canChangeStatusInProject('member', undefined, 'supersede')).toBe(false);
      expect(canChangeStatusInProject('member', null, 'deprecate')).toBe(false);
    });

    it('denies unknown transitions', () => {
      expect(canChangeStatusInProject('admin', 'project_admin', 'delete')).toBe(false);
    });
  });

  describe('resolveProjectRole', () => {
    it('returns project_admin for org admins regardless of project role', () => {
      expect(resolveProjectRole('admin', undefined)).toBe('project_admin');
      expect(resolveProjectRole('admin', null)).toBe('project_admin');
      expect(resolveProjectRole('admin', 'project_member')).toBe('project_admin');
    });

    it('returns the explicit project role for org members', () => {
      expect(resolveProjectRole('member', 'project_admin')).toBe('project_admin');
      expect(resolveProjectRole('member', 'project_member')).toBe('project_member');
    });

    it('returns undefined when org member has no project role', () => {
      expect(resolveProjectRole('member', undefined)).toBeUndefined();
      expect(resolveProjectRole('member', null)).toBeUndefined();
    });
  });
});
