import { describe, it, expect, beforeEach } from 'bun:test';
import { NotificationRepository, type Notification } from '../notification-repository';

interface QueryCall {
  sql: string;
  params: unknown[];
}

function createMockPool() {
  const queries: QueryCall[] = [];
  const resultQueue: { rows: unknown[] }[] = [];
  let defaultResult: { rows: unknown[] } = { rows: [] };
  let shouldThrow: Error | null = null;

  return {
    pool: {
      query: async (sql: string, params?: unknown[]) => {
        if (shouldThrow) throw shouldThrow;
        queries.push({ sql, params: params ?? [] });
        return resultQueue.length > 0 ? resultQueue.shift()! : defaultResult;
      },
    } as any,
    queries,
    pushResult(rows: unknown[]) {
      resultQueue.push({ rows });
    },
    setDefault(rows: unknown[]) {
      defaultResult = { rows };
    },
    setError(err: Error) {
      shouldThrow = err;
    },
    clearError() {
      shouldThrow = null;
    },
  };
}

describe('NotificationRepository', () => {
  let mockPool: ReturnType<typeof createMockPool>;
  let repo: NotificationRepository;

  beforeEach(() => {
    mockPool = createMockPool();
    repo = new NotificationRepository(mockPool.pool);
  });

  describe('createNotification', () => {
    it('should insert with correct SQL and params', async () => {
      await repo.createNotification('update', 'warning', 'Update available', 'nginx has an update');

      expect(mockPool.queries).toHaveLength(1);
      expect(mockPool.queries[0].sql).toContain('INSERT INTO notifications');
      expect(mockPool.queries[0].sql).toContain('type, severity, title, message');
      expect(mockPool.queries[0].params).toEqual(['update', 'warning', 'Update available', 'nginx has an update']);
    });

    it('should propagate errors', async () => {
      mockPool.setError(new Error('db error'));
      await expect(repo.createNotification('update', 'error', 'Fail', 'msg')).rejects.toThrow('db error');
    });
  });

  describe('getUndismissed', () => {
    it('should return rows where dismissed is false ordered by created_at DESC', async () => {
      const rows: Notification[] = [
        { id: 2, type: 'update', severity: 'warning', title: 'Title 2', message: 'Msg 2', created_at: '2024-01-02' },
        { id: 1, type: 'update', severity: 'error', title: 'Title 1', message: 'Msg 1', created_at: '2024-01-01' },
      ];
      mockPool.pushResult(rows);

      const result = await repo.getUndismissed();

      expect(result).toEqual(rows);
      expect(mockPool.queries).toHaveLength(1);
      expect(mockPool.queries[0].sql).toContain('dismissed = FALSE');
      expect(mockPool.queries[0].sql).toContain('ORDER BY created_at DESC');
    });

    it('should return empty array when no undismissed notifications', async () => {
      const result = await repo.getUndismissed();
      expect(result).toEqual([]);
    });
  });

  describe('dismiss', () => {
    it('should update dismissed to true for given ID', async () => {
      await repo.dismiss(42);

      expect(mockPool.queries).toHaveLength(1);
      expect(mockPool.queries[0].sql).toContain('UPDATE notifications');
      expect(mockPool.queries[0].sql).toContain('dismissed = TRUE');
      expect(mockPool.queries[0].params).toEqual([42]);
    });

    it('should propagate errors', async () => {
      mockPool.setError(new Error('not found'));
      await expect(repo.dismiss(1)).rejects.toThrow('not found');
    });
  });

  describe('dismissAll', () => {
    it('should update dismissed to true for all undismissed', async () => {
      await repo.dismissAll();

      expect(mockPool.queries).toHaveLength(1);
      expect(mockPool.queries[0].sql).toContain('UPDATE notifications');
      expect(mockPool.queries[0].sql).toContain('dismissed = TRUE');
      expect(mockPool.queries[0].sql).toContain('dismissed = FALSE');
    });

    it('should propagate errors', async () => {
      mockPool.setError(new Error('db down'));
      await expect(repo.dismissAll()).rejects.toThrow('db down');
    });
  });
});
