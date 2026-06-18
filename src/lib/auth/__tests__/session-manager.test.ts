import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test';
import { createHash } from 'crypto';
import { SessionManager, resetSessionManagerState } from '../session-manager';
import type { SessionManagerDeps } from '../session-manager';
import type { AuthUser } from '@/lib/auth/types';

// Mock the JWE encryption module so tests don't need real crypto keys
const mockEncryptValue = mock(async (_plaintext: string, _keyring: unknown) => 'jwe:mock:encrypted');
const mockDecryptValue = mock(async (ciphertext: string, _keyring: unknown) =>
  ciphertext.replace('jwe:mock:', ''),
);

mock.module('@/lib/crypto/encrypted-value', () => ({
  encryptValue: mockEncryptValue,
  decryptValue: mockDecryptValue,
}));

// Module mocks for buildSessionManager's dynamic imports
const mockBuiltPool = { query: mock(async () => ({ rows: [] })) };
const mockGetClient = mock(async () => ({ getPool: () => mockBuiltPool }));
const mockLoadMasterKeyring = mock(async () => ({ activeKid: 'v1', keys: new Map() }));

mock.module('@/lib/clients/database-client', () => ({
  databaseConnectionManager: { getClient: mockGetClient },
}));
mock.module('@/lib/config/database-config', () => ({
  loadDatabaseConfig: () => ({}),
}));
mock.module('@/lib/crypto/master-key', () => ({
  loadMasterKeyring: mockLoadMasterKeyring,
}));

function makeUser(overrides?: Partial<AuthUser>): AuthUser {
  return {
    id: 1,
    email: 'test@example.com',
    name: 'Test User',
    role: 'viewer',
    ...overrides,
  };
}

const testIdToken = 'id-token-123';

const mockKeyring = { activeKid: 'v1', keys: new Map() } as unknown as SessionManagerDeps['keyring'];

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
    keyring: mockKeyring,
    sessionTtlHours: 8,
    ...overrides,
  };
}

describe('SessionManager', () => {
  beforeEach(() => {
    resetSessionManagerState();
    mockEncryptValue.mockClear();
    mockDecryptValue.mockClear();
  });

  describe('createSession', () => {
    it('generates a random token and returns it as raw hex', async () => {
      const deps = makeDeps();
      const manager = new SessionManager(deps);

      const token = await manager.createSession(1, testIdToken, null, null);

      expect(typeof token).toBe('string');
      expect(token).toMatch(/^[0-9a-f]{64}$/);
    });

    it('hashes the token before storing as session id', async () => {
      const deps = makeDeps();
      const manager = new SessionManager(deps);

      const rawToken = await manager.createSession(1, testIdToken, '127.0.0.1', 'Mozilla/5.0');

      const expectedHash = createHash('sha256').update(rawToken).digest('hex');
      expect(deps.sessionRepo.create).toHaveBeenCalledTimes(1);
      const callArg = (deps.sessionRepo.create as ReturnType<typeof mock>).mock.calls[0][0] as { id: string };
      expect(callArg.id).toBe(expectedHash);
    });

    it('stores userId, ipAddress, and userAgent in the session row', async () => {
      const deps = makeDeps();
      const manager = new SessionManager(deps);

      await manager.createSession(42, testIdToken, '10.0.0.1', 'TestAgent/1.0');

      const callArg = (deps.sessionRepo.create as ReturnType<typeof mock>).mock.calls[0][0] as {
        userId: number;
        ipAddress: string | null;
        userAgent: string | null;
      };
      expect(callArg.userId).toBe(42);
      expect(callArg.ipAddress).toBe('10.0.0.1');
      expect(callArg.userAgent).toBe('TestAgent/1.0');
    });

    it('encrypts only the id_token via JWE before storing', async () => {
      const deps = makeDeps();
      const manager = new SessionManager(deps);

      await manager.createSession(1, testIdToken, null, null);

      expect(mockEncryptValue).toHaveBeenCalledTimes(1);
      const [plaintext] = mockEncryptValue.mock.calls[0] as [string, unknown];
      expect(JSON.parse(plaintext)).toEqual({ idToken: testIdToken });

      const createArg = (deps.sessionRepo.create as ReturnType<typeof mock>).mock.calls[0][0] as { encryptedOidc: string };
      expect(createArg.encryptedOidc).toBe('jwe:mock:encrypted');
    });

    it('sets expiresAt based on sessionTtlHours', async () => {
      const deps = makeDeps({ sessionTtlHours: 4 });
      const manager = new SessionManager(deps);
      const before = new Date();

      await manager.createSession(1, testIdToken, null, null);

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

      const token1 = await manager.createSession(1, testIdToken, null, null);
      const token2 = await manager.createSession(1, testIdToken, null, null);

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

  describe('getIdToken', () => {
    function depsWithEncryptedOidc(encryptedOidc: string): SessionManagerDeps {
      return makeDeps({
        sessionRepo: {
          create: mock(async () => {}),
          findById: mock(async () => ({
            session: { encryptedOidc } as never,
            user: makeUser(),
          })),
          findByUserId: mock(async () => []),
          deleteById: mock(async () => {}),
          deleteByUserId: mock(async () => {}),
          deleteExpired: mock(async () => {}),
        } as unknown as SessionManagerDeps['sessionRepo'],
      });
    }

    it('decrypts and returns the idToken from a current-format payload', async () => {
      const encryptedOidc = `jwe:mock:${JSON.stringify({ idToken: 'eyJ.test.token' })}`;
      const manager = new SessionManager(depsWithEncryptedOidc(encryptedOidc));

      const result = await manager.getIdToken('some-hashed-id');

      expect(result).toBe('eyJ.test.token');
    });

    it('returns null when the payload has no idToken field', async () => {
      const encryptedOidc = `jwe:mock:${JSON.stringify({ accessToken: 'access-abc' })}`;
      const manager = new SessionManager(depsWithEncryptedOidc(encryptedOidc));

      expect(await manager.getIdToken('some-hashed-id')).toBeNull();
    });

    it('returns null when session is not found', async () => {
      const deps = makeDeps();
      const manager = new SessionManager(deps);

      expect(await manager.getIdToken('no-such-id')).toBeNull();
    });

    it('returns null when encryptedOidc is null', async () => {
      const deps = makeDeps({
        sessionRepo: {
          create: mock(async () => {}),
          findById: mock(async () => ({
            session: { encryptedOidc: null } as never,
            user: makeUser(),
          })),
          findByUserId: mock(async () => []),
          deleteById: mock(async () => {}),
          deleteByUserId: mock(async () => {}),
          deleteExpired: mock(async () => {}),
        } as unknown as SessionManagerDeps['sessionRepo'],
      });
      const manager = new SessionManager(deps);

      expect(await manager.getIdToken('some-id')).toBeNull();
    });

    it('returns null when decryptValue throws', async () => {
      const encryptedOidc = 'jwe:mock:some-payload';
      const deps = makeDeps({
        sessionRepo: {
          create: mock(async () => {}),
          findById: mock(async () => ({
            session: { encryptedOidc } as never,
            user: makeUser(),
          })),
          findByUserId: mock(async () => []),
          deleteById: mock(async () => {}),
          deleteByUserId: mock(async () => {}),
          deleteExpired: mock(async () => {}),
        } as unknown as SessionManagerDeps['sessionRepo'],
      });
      const manager = new SessionManager(deps);

      mockDecryptValue.mockImplementationOnce(async () => {
        throw new Error('decryption failed');
      });

      const result = await manager.getIdToken('some-hashed-id');

      expect(result).toBeNull();
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

describe('buildSessionManager', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    resetSessionManagerState();
    mockGetClient.mockClear();
    mockLoadMasterKeyring.mockClear();
    // loadAuthConfig requires these vars; set them here instead of mocking the module
    // (module mocks for auth-config leak across test files despite --isolate)
    process.env.OIDC_ISSUER_URL = 'https://pocketid.example.com';
    process.env.OIDC_CLIENT_ID = 'homelab-manager';
    process.env.OIDC_REDIRECT_URI = 'http://localhost/callback';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    resetSessionManagerState();
  });

  it('builds a SessionManager with injected dependencies', async () => {
    const { buildSessionManager } = await import('../session-manager');
    const manager = await buildSessionManager();
    expect(manager).toBeInstanceOf(SessionManager);
  });

  it('caches the manager and returns the same instance on subsequent calls', async () => {
    const { buildSessionManager } = await import('../session-manager');
    const first = await buildSessionManager();
    const second = await buildSessionManager();
    expect(first).toBe(second);
    // getClient is called once — second call hits the cache
    expect(mockGetClient).toHaveBeenCalledTimes(1);
  });

  it('creates a fresh manager after resetSessionManagerState', async () => {
    const { buildSessionManager } = await import('../session-manager');
    const first = await buildSessionManager();
    resetSessionManagerState();
    const second = await buildSessionManager();
    expect(first).not.toBe(second);
  });
});
