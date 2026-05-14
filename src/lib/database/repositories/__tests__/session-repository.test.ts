import { describe, it, expect, beforeEach } from 'bun:test';
import { SessionRepository } from '../session-repository';
import type { SessionRow, CreateSessionInput } from '../session-repository';
import type { AuthUser } from '@/lib/auth/types';

function createMockPool(rows: Record<string, unknown>[] = []) {
  const queryResults: Record<string, unknown>[][] = [];
  return {
    pool: {
      query: async (_sql: string, _params?: unknown[]) => {
        const result = queryResults.length > 0 ? queryResults.shift()! : rows;
        return { rows: result };
      },
    } as any,
    /** Push a result set that will be returned by the next query call */
    pushResult(r: Record<string, unknown>[]) {
      queryResults.push(r);
    },
  };
}

const baseSessionRow: SessionRow = {
  id: 'hashed-session-id',
  userId: 1,
  encryptedOidc: 'encrypted-token-data',
  ipAddress: '127.0.0.1',
  userAgent: 'Mozilla/5.0',
  expiresAt: new Date('2099-01-01T00:00:00Z'),
  createdAt: new Date('2024-01-01T00:00:00Z'),
};

const baseAuthUser: AuthUser = {
  id: 1,
  email: 'alice@example.com',
  name: 'Alice',
  role: 'viewer',
};

/** Raw DB row shape returned by the JOIN query */
const baseJoinRow = {
  id: baseSessionRow.id,
  user_id: baseSessionRow.userId,
  encrypted_oidc: baseSessionRow.encryptedOidc,
  ip_address: baseSessionRow.ipAddress,
  user_agent: baseSessionRow.userAgent,
  expires_at: baseSessionRow.expiresAt,
  created_at: baseSessionRow.createdAt,
  u_id: baseAuthUser.id,
  email: baseAuthUser.email,
  name: baseAuthUser.name,
  role: baseAuthUser.role,
};

describe('SessionRepository', () => {
  let repo: SessionRepository;
  let mock: ReturnType<typeof createMockPool>;

  beforeEach(() => {
    mock = createMockPool();
    repo = new SessionRepository(mock.pool);
  });

  describe('create', () => {
    it('inserts session with hashed ID, user_id, encrypted_oidc, ip, user_agent, expires_at', async () => {
      const capturedParams: unknown[][] = [];
      const capturingPool = {
        query: async (_sql: string, params?: unknown[]) => {
          if (params) capturedParams.push(params);
          return { rows: [] };
        },
      } as any;
      const capturingRepo = new SessionRepository(capturingPool);

      const input: CreateSessionInput = {
        id: 'hashed-session-id',
        userId: 1,
        encryptedOidc: 'encrypted-token-data',
        ipAddress: '127.0.0.1',
        userAgent: 'Mozilla/5.0',
        expiresAt: new Date('2099-01-01T00:00:00Z'),
      };

      await capturingRepo.create(input);

      expect(capturedParams).toHaveLength(1);
      const [id, userId, encryptedOidc, ipAddress, userAgent, expiresAt] = capturedParams[0] as unknown[];
      expect(id).toBe('hashed-session-id');
      expect(userId).toBe(1);
      expect(encryptedOidc).toBe('encrypted-token-data');
      expect(ipAddress).toBe('127.0.0.1');
      expect(userAgent).toBe('Mozilla/5.0');
      expect(expiresAt).toEqual(new Date('2099-01-01T00:00:00Z'));
    });

    it('accepts null encryptedOidc, ipAddress, and userAgent', async () => {
      mock.pushResult([]);
      const input: CreateSessionInput = {
        id: 'hashed-session-id',
        userId: 1,
        encryptedOidc: null,
        ipAddress: null,
        userAgent: null,
        expiresAt: new Date('2099-01-01T00:00:00Z'),
      };
      await expect(repo.create(input)).resolves.toBeUndefined();
    });
  });

  describe('findById', () => {
    it('returns session joined with user when session exists', async () => {
      mock.pushResult([baseJoinRow as unknown as Record<string, unknown>]);
      const result = await repo.findById('hashed-session-id');

      expect(result).not.toBeNull();
      expect(result!.session.id).toBe('hashed-session-id');
      expect(result!.session.userId).toBe(1);
      expect(result!.session.encryptedOidc).toBe('encrypted-token-data');
      expect(result!.session.ipAddress).toBe('127.0.0.1');
      expect(result!.session.userAgent).toBe('Mozilla/5.0');
      expect(result!.session.expiresAt).toEqual(new Date('2099-01-01T00:00:00Z'));
      expect(result!.session.createdAt).toEqual(new Date('2024-01-01T00:00:00Z'));
      expect(result!.user.id).toBe(1);
      expect(result!.user.email).toBe('alice@example.com');
      expect(result!.user.name).toBe('Alice');
      expect(result!.user.role).toBe('viewer');
    });

    it('returns null for non-existent session', async () => {
      mock.pushResult([]);
      const result = await repo.findById('nonexistent-id');
      expect(result).toBeNull();
    });

    it('returns null for expired session (query filters by expires_at > now())', async () => {
      // The DB query already excludes expired sessions via WHERE expires_at > now()
      // Simulate this by returning no rows (as the DB would do for expired sessions)
      mock.pushResult([]);
      const result = await repo.findById('expired-session-id');
      expect(result).toBeNull();
    });
  });

  describe('findByUserId', () => {
    it('returns all sessions for a user', async () => {
      const sessionRows = [
        {
          id: 'session-1',
          user_id: 1,
          encrypted_oidc: 'enc-1',
          ip_address: '127.0.0.1',
          user_agent: 'Agent/1',
          expires_at: new Date('2099-01-01T00:00:00Z'),
          created_at: new Date('2024-01-01T00:00:00Z'),
        },
        {
          id: 'session-2',
          user_id: 1,
          encrypted_oidc: null,
          ip_address: '192.168.1.1',
          user_agent: 'Agent/2',
          expires_at: new Date('2099-06-01T00:00:00Z'),
          created_at: new Date('2024-06-01T00:00:00Z'),
        },
      ];
      mock.pushResult(sessionRows as unknown as Record<string, unknown>[]);
      const result = await repo.findByUserId(1);

      expect(result).toHaveLength(2);
      expect(result[0].id).toBe('session-1');
      expect(result[0].userId).toBe(1);
      expect(result[1].id).toBe('session-2');
      expect(result[1].encryptedOidc).toBeNull();
    });

    it('returns empty array when no sessions exist for user', async () => {
      mock.pushResult([]);
      const result = await repo.findByUserId(999);
      expect(result).toEqual([]);
    });
  });

  describe('deleteById', () => {
    it('removes a single session by id', async () => {
      mock.pushResult([]);
      await expect(repo.deleteById('hashed-session-id')).resolves.toBeUndefined();
    });
  });

  describe('deleteByUserId', () => {
    it('removes all sessions for a user', async () => {
      mock.pushResult([]);
      await expect(repo.deleteByUserId(1)).resolves.toBeUndefined();
    });
  });

  describe('deleteExpired', () => {
    it('removes sessions past expires_at', async () => {
      mock.pushResult([]);
      await expect(repo.deleteExpired()).resolves.toBeUndefined();
    });
  });

  describe('findAllWithUser', () => {
    it('returns sessions joined with user info', async () => {
      const joinRows = [
        {
          id: 'session-1',
          user_id: 1,
          encrypted_oidc: 'enc-data',
          ip_address: '127.0.0.1',
          user_agent: 'Mozilla/5.0',
          expires_at: new Date('2099-01-01'),
          created_at: new Date('2024-01-01'),
          user_name: 'Alice',
          user_email: 'alice@example.com',
        },
      ];
      mock.pushResult(joinRows as unknown as Record<string, unknown>[]);
      const result = await repo.findAllWithUser();

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('session-1');
      expect(result[0].userId).toBe(1);
      expect(result[0].encryptedOidc).toBe('enc-data');
      expect(result[0].userName).toBe('Alice');
      expect(result[0].userEmail).toBe('alice@example.com');
    });

    it('returns empty array when no active sessions exist', async () => {
      mock.pushResult([]);
      const result = await repo.findAllWithUser();
      expect(result).toEqual([]);
    });

    it('handles null user_name', async () => {
      const joinRows = [
        {
          id: 'session-2',
          user_id: 2,
          encrypted_oidc: null,
          ip_address: null,
          user_agent: null,
          expires_at: new Date('2099-01-01'),
          created_at: new Date('2024-01-01'),
          user_name: null,
          user_email: 'bob@example.com',
        },
      ];
      mock.pushResult(joinRows as unknown as Record<string, unknown>[]);
      const result = await repo.findAllWithUser();

      expect(result[0].userName).toBeNull();
      expect(result[0].userEmail).toBe('bob@example.com');
    });
  });
});
