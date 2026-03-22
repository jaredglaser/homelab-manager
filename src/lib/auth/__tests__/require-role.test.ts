import { describe, it, expect } from 'bun:test';
import { requireRole, ForbiddenError } from '@/lib/auth/require-role';
import type { AuthUser } from '@/lib/auth/types';

function makeUser(role: AuthUser['role']): AuthUser {
  return {
    id: 1,
    email: `${role}@example.com`,
    name: role,
    role,
  };
}

describe('requireRole', () => {
  describe('single allowed role', () => {
    it('does not throw when user has the required role', () => {
      const guard = requireRole('admin');
      expect(() => guard(makeUser('admin'))).not.toThrow();
    });

    it('throws ForbiddenError when user has a different role', () => {
      const guard = requireRole('admin');
      expect(() => guard(makeUser('operator'))).toThrow(ForbiddenError);
    });

    it('throws ForbiddenError when viewer tries to access admin route', () => {
      const guard = requireRole('admin');
      expect(() => guard(makeUser('viewer'))).toThrow(ForbiddenError);
    });
  });

  describe('multiple allowed roles', () => {
    it('does not throw when user is admin and both admin and operator are allowed', () => {
      const guard = requireRole('admin', 'operator');
      expect(() => guard(makeUser('admin'))).not.toThrow();
    });

    it('does not throw when user is operator and both admin and operator are allowed', () => {
      const guard = requireRole('admin', 'operator');
      expect(() => guard(makeUser('operator'))).not.toThrow();
    });

    it('throws ForbiddenError when viewer tries to access admin/operator route', () => {
      const guard = requireRole('admin', 'operator');
      expect(() => guard(makeUser('viewer'))).toThrow(ForbiddenError);
    });
  });

  describe('all roles allowed', () => {
    it('does not throw for any role when all are allowed', () => {
      const guard = requireRole('admin', 'operator', 'viewer');
      expect(() => guard(makeUser('admin'))).not.toThrow();
      expect(() => guard(makeUser('operator'))).not.toThrow();
      expect(() => guard(makeUser('viewer'))).not.toThrow();
    });
  });
});

describe('ForbiddenError', () => {
  it('has status 403', () => {
    const err = new ForbiddenError();
    expect(err.status).toBe(403);
  });

  it('has default message "Insufficient permissions"', () => {
    const err = new ForbiddenError();
    expect(err.message).toBe('Insufficient permissions');
  });

  it('accepts a custom message', () => {
    const err = new ForbiddenError('Custom forbidden message');
    expect(err.message).toBe('Custom forbidden message');
  });

  it('is an instance of Error', () => {
    expect(new ForbiddenError()).toBeInstanceOf(Error);
  });

  it('name is ForbiddenError', () => {
    expect(new ForbiddenError().name).toBe('ForbiddenError');
  });
});
