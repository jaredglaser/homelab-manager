import { describe, it, expect } from 'bun:test';
import { mapGroupsToRole } from '@/lib/auth/role-mapper';
import type { RoleMappingConfig } from '@/lib/auth/types';

const mockMapping: RoleMappingConfig = {
  admin: 'group-admin',
  operator: 'group-operator',
  viewer: 'group-viewer',
};

describe('mapGroupsToRole', () => {
  it('returns "admin" when user groups contain the admin group name', () => {
    const groups = ['group-admin', 'other-group'];
    expect(mapGroupsToRole(groups, mockMapping)).toBe('admin');
  });

  it('returns "operator" when user groups contain the operator group name', () => {
    const groups = ['group-operator', 'other-group'];
    expect(mapGroupsToRole(groups, mockMapping)).toBe('operator');
  });

  it('returns "viewer" when user groups contain the viewer group name', () => {
    const groups = ['group-viewer', 'other-group'];
    expect(mapGroupsToRole(groups, mockMapping)).toBe('viewer');
  });

  it('returns "admin" (highest) when user belongs to both admin and viewer groups', () => {
    const groups = ['group-admin', 'group-viewer'];
    expect(mapGroupsToRole(groups, mockMapping)).toBe('admin');
  });

  it('returns "operator" when user belongs to both operator and viewer groups', () => {
    const groups = ['group-operator', 'group-viewer'];
    expect(mapGroupsToRole(groups, mockMapping)).toBe('operator');
  });

  it('returns null when user belongs to no mapped groups', () => {
    const groups = ['group-other', 'another-group'];
    expect(mapGroupsToRole(groups, mockMapping)).toBeNull();
  });

  it('handles empty groups array', () => {
    const groups: string[] = [];
    expect(mapGroupsToRole(groups, mockMapping)).toBeNull();
  });

  it('handles case sensitivity (exact match)', () => {
    const groups = ['Group-Admin', 'GROUP-VIEWER'];
    expect(mapGroupsToRole(groups, mockMapping)).toBeNull();
  });
});
