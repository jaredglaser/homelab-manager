import { describe, it, expect, beforeEach } from 'bun:test';
import { UserRepository } from '../user-repository';
import type { UserRow } from '../user-repository';

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

/** DB-shaped row (snake_case) as returned by PostgreSQL */
const baseDbRow: Record<string, unknown> = {
  id: 1,
  oidc_subject: 'sub|abc123',
  email: 'alice@example.com',
  name: 'Alice',
  role: 'viewer',
  oidc_groups: ['viewers'],
  last_login: new Date('2024-01-01T00:00:00Z'),
  created_at: new Date('2024-01-01T00:00:00Z'),
  updated_at: new Date('2024-01-01T00:00:00Z'),
};

/** Expected camelCase UserRow after conversion */
const baseUserRow: UserRow = {
  id: 1,
  oidcSubject: 'sub|abc123',
  email: 'alice@example.com',
  name: 'Alice',
  role: 'viewer',
  oidcGroups: ['viewers'],
  lastLogin: new Date('2024-01-01T00:00:00Z'),
  createdAt: new Date('2024-01-01T00:00:00Z'),
  updatedAt: new Date('2024-01-01T00:00:00Z'),
};

describe('UserRepository', () => {
  let repo: UserRepository;
  let mock: ReturnType<typeof createMockPool>;

  beforeEach(() => {
    mock = createMockPool();
    repo = new UserRepository(mock.pool);
  });

  describe('upsertFromOidc', () => {
    it('creates new user when oidc_subject does not exist', async () => {
      mock.pushResult([baseDbRow]);
      const result = await repo.upsertFromOidc({
        oidcSubject: 'sub|abc123',
        email: 'alice@example.com',
        name: 'Alice',
        role: 'viewer',
        groups: ['viewers'],
      });
      expect(result.id).toBe(1);
      expect(result.oidcSubject).toBe('sub|abc123');
      expect(result.email).toBe('alice@example.com');
      expect(result.name).toBe('Alice');
      expect(result.role).toBe('viewer');
      expect(result.oidcGroups).toEqual(['viewers']);
    });

    it('updates existing user email, name, role, groups, and lastLogin', async () => {
      const updatedDbRow: Record<string, unknown> = {
        ...baseDbRow,
        email: 'alice-new@example.com',
        name: 'Alice Updated',
        role: 'admin',
        oidc_groups: ['admins', 'operators'],
        last_login: new Date('2024-06-01T00:00:00Z'),
        updated_at: new Date('2024-06-01T00:00:00Z'),
      };
      mock.pushResult([updatedDbRow]);
      const result = await repo.upsertFromOidc({
        oidcSubject: 'sub|abc123',
        email: 'alice-new@example.com',
        name: 'Alice Updated',
        role: 'admin',
        groups: ['admins', 'operators'],
      });
      expect(result.email).toBe('alice-new@example.com');
      expect(result.name).toBe('Alice Updated');
      expect(result.role).toBe('admin');
      expect(result.oidcGroups).toEqual(['admins', 'operators']);
      expect(result.lastLogin).toEqual(new Date('2024-06-01T00:00:00Z'));
    });
  });

  describe('findById', () => {
    it('returns user when exists', async () => {
      mock.pushResult([baseDbRow]);
      const result = await repo.findById(1);
      expect(result).not.toBeNull();
      expect(result!.id).toBe(1);
      expect(result!.email).toBe('alice@example.com');
    });

    it('returns null when not found', async () => {
      mock.pushResult([]);
      const result = await repo.findById(999);
      expect(result).toBeNull();
    });
  });

  describe('findBySubject', () => {
    it('returns user by OIDC subject claim', async () => {
      mock.pushResult([baseDbRow]);
      const result = await repo.findBySubject('sub|abc123');
      expect(result).not.toBeNull();
      expect(result!.oidcSubject).toBe('sub|abc123');
      expect(result!.email).toBe('alice@example.com');
    });

    it('returns null when subject not found', async () => {
      mock.pushResult([]);
      const result = await repo.findBySubject('sub|notexist');
      expect(result).toBeNull();
    });
  });

  describe('findAll', () => {
    it('returns all users ordered by name', async () => {
      const rows: Record<string, unknown>[] = [
        { ...baseDbRow, id: 2, name: 'Alice', email: 'alice@example.com' },
        { ...baseDbRow, id: 3, name: 'Bob', email: 'bob@example.com' },
      ];
      mock.pushResult(rows);
      const result = await repo.findAll();
      expect(result).toHaveLength(2);
      expect(result[0].name).toBe('Alice');
      expect(result[1].name).toBe('Bob');
    });

    it('returns empty array when no users exist', async () => {
      mock.pushResult([]);
      const result = await repo.findAll();
      expect(result).toEqual([]);
    });
  });

  describe('rowToUser conversion', () => {
    it('maps snake_case DB columns to camelCase UserRow fields', async () => {
      mock.pushResult([baseDbRow]);
      const result = await repo.findById(1);
      expect(result).toEqual(baseUserRow);
    });
  });
});
