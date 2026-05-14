import type { Role, RoleMappingConfig } from '@/lib/auth/types';

const ROLE_PRIORITY: Role[] = ['admin', 'operator', 'viewer'];

export function mapGroupsToRole(groups: string[], mapping: RoleMappingConfig): Role | null {
  for (const role of ROLE_PRIORITY) {
    if (groups.includes(mapping[role])) {
      return role;
    }
  }
  return null;
}
