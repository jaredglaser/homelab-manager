import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { createHash } from 'crypto';
import { SessionManager, resetSessionManagerState } from '../session-manager';
import type { SessionManagerDeps } from '../session-manager';
import type { AuthUser, OidcTokens } from '@/lib/auth/types';

function makeUser(overrides?: Partial<AuthUser>): AuthUser {
  return {
    id: 1,
    email: 'test@example.com',
    name: 'Test User',
    role: 'viewer',
    ...overrides,
  };
}

function makeTokens(overrides?: Partial<OidcTokens>): OidcTokens {
  return {
    accessToken: 'access-abc',
    refreshToken: 'refresh-xyz',
    idToken: 'id-token-123',
    ...overrides,
  };
}

function makeDeps(overrides?: Partial<SessionManagerDeps>): SessionManagerDeps {
  return {
    sessionRepo: {
      create: mock(async () => {}),
      findById: mock(async () => null),
      findByUserId: mock(async () => []),
      deleteById: mock(async () => {}),
      deleteByUserId: mock(async () => {}),
      deleteExpired: mock(async () => {}),
    } as unknown as SessionManagerDeps['sessionRepo'],
    transitClient: {
      encrypt: mock(async (_key: string, plaintext: string) => `vault:v1:${btoa(plaintext)}`),
      decrypt: mock(async (_key: string, ciphertext: string) => atob(ciphertext.replace('vault:v1:', ''))),
    } as unknown as SessionManagerDeps['transitClient'],
    sessionTtlHours: 8,
    ...overrides,
  };
}

describe('SessionManager', () => {
  beforeEach(() => {
    resetSessionManagerState();
  });

  describe('createSession', () => {
    it('generates a random token and returns it as raw hex', async () => {
      const deps = makeDeps();
      const manager = new SessionManager(deps);

      const token = await manager.createSession(1, makeTokens(), null, null);

      expect(typeof token).toBe('string');
      expect(token).toMatch(/^[0-9a-f]{64}$/);
    });

    it('hashes the token before storing as session id', async () => {
      const deps = makeDeps();
      const manager = new SessionManager(deps);

      const rawToken = await manager.createSession(1, makeTokens(), '127.0.0.1', 'Mozilla/5.0');

      const expectedHash = createHash('sha256').update(rawToken).digest('hex');
      expect(deps.sessionRepo.create).toHaveBeenCalledTimes(1);
      const callArg = (deps.sessionRepo.create as ReturnType<typeof mock>).mock.calls[0][0] as { id: string };
      expect(callArg.id).toBe(expectedHash);
    });

    it('stores userId, ipAddress, and userAgent in the session row', async () => {
      const deps = makeDeps();
      const manager = new SessionManager(deps);

      await manager.createSession(42, makeTokens(), '10.0.0.1', 'TestAgent/1.0');

      const callArg = (deps.sessionRepo.create as ReturnType<typeof mock>).mock.calls[0][0] as {
        userId: number;
        ipAddress: string | null;
        userAgent: string | null;
      };
      expect(callArg.userId).toBe(42);
      expect(callArg.ipAddress).toBe('10.0.0.1');
      expect(callArg.userAgent).toBe('TestAgent/1.0');
    });

    it('encrypts OIDC tokens via Transit before storing', async () => {
      const deps = makeDeps();
      const manager = new SessionManager(deps);
      const tokens = makeTokens();

      await manager.createSession(1, tokens, null, null);

      expect(deps.transitClient.encrypt).toHaveBeenCalledTimes(1);
      const [keyName, plaintext] = (deps.transitClient.encrypt as ReturnType<typeof mock>).mock.calls[0] as [string, string];
      expect(keyName).toBe('session-tokens');
      expect(JSON.parse(plaintext)).toEqual(tokens);

      const createArg = (deps.sessionRepo.create as ReturnType<typeof mock>).mock.calls[0][0] as { encryptedOidc: string };
      expect(createArg.encryptedOidc).toMatch(/^vault:v1:/);
    });

    it('sets expiresAt based on sessionTtlHours', async () => {
      const deps = makeDeps({ sessionTtlHours: 4 });
      const manager = new SessionManager(deps);
      const before = new Date();

      await manager.createSession(1, makeTokens(), null, null);

      const after = new Date();
      const createArg = (deps.sessionRepo.create as ReturnType<typeof mock>).mock.calls[0][0] as { expiresAt: Date };
      const expiresAt = createArg.expiresAt;

      const minExpected = new Date(before.getTime() + 4 * 60 * 60 * 1000);
      const maxExpected = new Date(after.getTime() + 4 * 60 * 60 * 1000);
      expect(expiresAt.getTime()).toBeGreaterThanOrEqual(minExpected.getTime());
      expect(expiresAt.getTime()).toBeLessThanOrEqual(maxExpected.getTime());
    });

    it('returns distinct tokens on each call', async () => {
      const deps = makeDeps();
      const manager = new SessionManager(deps);

      const token1 = await manager.createSession(1, makeTokens(), null, null);
      const token2 = await manager.createSession(1, makeTokens(), null, null);

      expect(token1).not.toBe(token2);
    });
  });

  describe('validateSession', () => {
    it('hashes the raw token, looks up the session, and returns the AuthUser', async () => {
      const user = makeUser({ id: 5, email: 'alice@example.com', role: 'admin' });
      const deps = makeDeps({
        sessionRepo: {
          create: mock(async () => {}),
          findById: mock(async () => ({ session: {} as never, user })),
          findByUserId: mock(async () => []),
          deleteById: mock(async () => {}),
          deleteByUserId: mock(async () => {}),
          deleteExpired: mock(async () => {}),
        } as unknown as SessionManagerDeps['sessionRepo'],
      });
      const manager = new SessionManager(deps);
      const rawToken = 'a'.repeat(64);

      const result = await manager.validateSession(rawToken);

      const expectedHash = createHash('sha256').update(rawToken).digest('hex');
      expect(deps.sessionRepo.findById).toHaveBeenCalledWith(expectedHash);
      expect(result).toEqual(user);
    });

    it('returns null when session is not found', async () => {
      const deps = makeDeps();
      const manager = new SessionManager(deps);

      const result = await manager.validateSession('no-such-token');

      expect(result).toBeNull();
    });

    it('returns null for an expired session (repo returns null)', async () => {
      const deps = makeDeps({
        sessionRepo: {
          create: mock(async () => {}),
          findById: mock(async () => null),
          findByUserId: mock(async () => []),
          deleteById: mock(async () => {}),
          deleteByUserId: mock(async () => {}),
          deleteExpired: mock(async () => {}),
        } as unknown as SessionManagerDeps['sessionRepo'],
      });
      const manager = new SessionManager(deps);

      const result = await manager.validateSession('expired-token');

      expect(result).toBeNull();
    });
  });

  describe('revokeSession', () => {
    it('deletes the session by hashed id', async () => {
      const deps = makeDeps();
      const manager = new SessionManager(deps);
      const hashedId = 'abc123hash';

      await manager.revokeSession(hashedId);

      expect(deps.sessionRepo.deleteById).toHaveBeenCalledWith(hashedId);
    });
  });

  describe('revokeAllUserSessions', () => {
    it('deletes all sessions for a given user id', async () => {
      const deps = makeDeps();
      const manager = new SessionManager(deps);

      await manager.revokeAllUserSessions(99);

      expect(deps.sessionRepo.deleteByUserId).toHaveBeenCalledWith(99);
    });
  });

  describe('cleanupExpired', () => {
    it('delegates to sessionRepo.deleteExpired', async () => {
      const deps = makeDeps();
      const manager = new SessionManager(deps);

      await manager.cleanupExpired();

      expect(deps.sessionRepo.deleteExpired).toHaveBeenCalledTimes(1);
    });
  });
});
