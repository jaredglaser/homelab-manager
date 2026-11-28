import { describe, it, expect, mock } from 'bun:test';
import { roleMiddleware } from '@/lib/auth/role-middleware';
import { ForbiddenError } from '@/lib/auth/require-role';
import { authMiddleware } from '@/middleware/auth-middleware';
import type { AuthUser, Role } from '@/lib/auth/types';

type Allowed = Parameters<typeof roleMiddleware>;
type RoleCheck = (ctx: { context: { user?: AuthUser }; next: () => string }) => string;

function userWith(role: Role): AuthUser {
  return { id: 1, email: `${role}@example.com`, name: role, role };
}

function serverCheck(...allowed: Allowed): RoleCheck {
  return roleMiddleware(...allowed).options.server as unknown as RoleCheck;
}

describe('roleMiddleware', () => {
  it('runs authMiddleware first, so the user it checks is always resolved', () => {
    expect(roleMiddleware('admin').options.middleware).toEqual([authMiddleware]);
  });

  it.each<[Allowed, Role]>([
    [['admin'], 'admin'],
    [['admin', 'operator'], 'operator'],
    [['admin', 'operator', 'viewer'], 'viewer'],
  ])('passes %p through for a %s', (allowed, role) => {
    const next = mock(() => 'next');
    expect(serverCheck(...allowed)({ context: { user: userWith(role) }, next })).toBe('next');
    expect(next).toHaveBeenCalledTimes(1);
  });

  it.each<[Allowed, Role]>([
    [['admin'], 'operator'],
    [['admin'], 'viewer'],
    [['admin', 'operator'], 'viewer'],
  ])('refuses %p to a %s without calling next', (allowed, role) => {
    const next = mock(() => 'next');
    expect(() => serverCheck(...allowed)({ context: { user: userWith(role) }, next })).toThrow(ForbiddenError);
    expect(next).not.toHaveBeenCalled();
  });

  it('refuses a context with no user', () => {
    const next = mock(() => 'next');
    expect(() => serverCheck('admin', 'operator', 'viewer')({ context: {}, next })).toThrow(ForbiddenError);
    expect(next).not.toHaveBeenCalled();
  });
});
