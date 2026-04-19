import { describe, it, expect, beforeEach } from 'bun:test';
import { DeployRepository } from '../deploy-repository';
import { createMockPool } from '@/lib/test/mock-pool';

describe('DeployRepository', () => {
  let repo: DeployRepository;
  let mock: ReturnType<typeof createMockPool>;

  beforeEach(() => {
    mock = createMockPool();
    repo = new DeployRepository(mock.pool);
  });

  describe('insertDeploy', () => {
    it('inserts a deploy record and returns the id', async () => {
      mock.pushResult([{ id: '42' }]);
      const id = await repo.insertDeploy({
        stack: 'plex',
        host: 'homeserver',
        commitSha: 'abc123',
        composeHash: 'hash1',
        envHash: 'hash2',
        status: 'pending',
        trigger: 'git_push',
        action: 'deploy',
      });

      expect(id).toBe(42);
      expect(mock.queries[0].sql).toContain('INSERT INTO deploy_history');
      expect(mock.queries[0].params).toEqual([
        'plex', 'homeserver', 'abc123', 'hash1', 'hash2', 'pending', 'git_push', 'deploy', false,
      ]);
    });
  });

  describe('getById', () => {
    it('returns null when deploy does not exist', async () => {
      mock.pushResult([]);
      const result = await repo.getById(999);
      expect(result).toBeNull();
    });

    it('returns the deploy record with Number-coerced id', async () => {
      mock.pushResult([{
        id: '42',
        stack: 'plex',
        host: 'homeserver',
        commit_sha: 'abc123',
        compose_hash: 'hash1',
        env_hash: 'hash2',
        status: 'pending',
        trigger: 'git_push',
        logs: null,
        created_at: new Date('2026-01-01'),
      }]);

      const result = await repo.getById(42);
      expect(result).not.toBeNull();
      expect(result!.id).toBe(42);
      expect(result!.stack).toBe('plex');
      expect(result!.status).toBe('pending');
    });
  });

  describe('updateStatus', () => {
    it('updates status and logs for a deploy record', async () => {
      mock.pushResult([{}]); // 1 row affected
      await repo.updateStatus(42, 'succeeded', 'deployment complete');

      expect(mock.queries[0].sql).toContain('UPDATE deploy_history');
      expect(mock.queries[0].params).toEqual([42, 'succeeded', 'deployment complete']);
    });

    it('throws when deploy record does not exist', async () => {
      mock.pushResult([]); // 0 rows affected
      await expect(repo.updateStatus(999, 'failed')).rejects.toThrow('Deploy record 999 not found');
    });
  });

  describe('getLatestSuccessful', () => {
    it('returns null when no successful deploy exists', async () => {
      mock.pushResult([]);
      const result = await repo.getLatestSuccessful('plex', 'homeserver');
      expect(result).toBeNull();
    });

    it('returns the latest successful deploy with Number-coerced id', async () => {
      mock.pushResult([{
        id: '10',
        stack: 'plex',
        host: 'homeserver',
        commit_sha: 'abc123',
        compose_hash: 'hash1',
        env_hash: 'hash2',
        status: 'succeeded',
        trigger: 'git_push',
        logs: 'ok',
        created_at: new Date('2026-01-01'),
      }]);

      const result = await repo.getLatestSuccessful('plex', 'homeserver');
      expect(result).not.toBeNull();
      expect(result!.id).toBe(10);
      expect(result!.stack).toBe('plex');
      expect(result!.composeHash).toBe('hash1');
    });
  });

  describe('hasActiveDeployForStack', () => {
    it('returns false when no active deploy exists', async () => {
      mock.pushResult([{ count: '0' }]);
      const result = await repo.hasActiveDeployForStack('plex', 'homeserver');
      expect(result).toBe(false);
      expect(mock.queries[0].params).toEqual(['plex', 'homeserver']);
    });

    it('returns true when an active deploy exists', async () => {
      mock.pushResult([{ count: '1' }]);
      const result = await repo.hasActiveDeployForStack('plex', 'homeserver');
      expect(result).toBe(true);
    });
  });

  describe('insertDeployIfNoActive', () => {
    const insertParams = {
      stack: 'plex',
      host: 'homeserver',
      commitSha: 'abc123',
      composeHash: 'hash1',
      envHash: 'hash2',
      status: 'pending' as const,
      trigger: 'git_push' as const,
      action: 'deploy' as const,
    };

    it('returns the deploy id when no active deploy exists', async () => {
      mock.pushResult([{ id: '42' }]);
      const id = await repo.insertDeployIfNoActive(insertParams);
      expect(id).toBe(42);
    });

    it('returns null when the active-deploy unique constraint is violated', async () => {
      const violationPool = {
        query: async () => {
          const err = new Error('duplicate key') as Error & { code: string; constraint: string };
          err.code = '23505';
          err.constraint = 'idx_deploy_one_active_per_stack_host';
          throw err;
        },
      } as any;
      const violationRepo = new DeployRepository(violationPool);

      const id = await violationRepo.insertDeployIfNoActive(insertParams);
      expect(id).toBeNull();
    });

    it('re-throws unique violations from other constraints', async () => {
      const violationPool = {
        query: async () => {
          const err = new Error('duplicate key') as Error & { code: string; constraint: string };
          err.code = '23505';
          err.constraint = 'some_other_unique_index';
          throw err;
        },
      } as any;
      const violationRepo = new DeployRepository(violationPool);

      await expect(violationRepo.insertDeployIfNoActive(insertParams)).rejects.toThrow('duplicate key');
    });

    it('re-throws non-unique-violation errors', async () => {
      const errorPool = {
        query: async () => { throw new Error('connection lost'); },
      } as any;
      const errorRepo = new DeployRepository(errorPool);

      await expect(errorRepo.insertDeployIfNoActive(insertParams)).rejects.toThrow('connection lost');
    });
  });

  describe('getDeployHistory', () => {
    it('returns deploy records for a stack ordered by created_at desc', async () => {
      mock.pushResult([
        {
          id: '2', stack: 'plex', host: 'homeserver', commit_sha: 'def456',
          compose_hash: 'h3', env_hash: 'h4', status: 'succeeded',
          trigger: 'ui', logs: null, created_at: new Date('2026-01-02'),
        },
        {
          id: '1', stack: 'plex', host: 'homeserver', commit_sha: 'abc123',
          compose_hash: 'h1', env_hash: 'h2', status: 'failed',
          trigger: 'git_push', logs: 'error', created_at: new Date('2026-01-01'),
        },
      ]);

      const records = await repo.getDeployHistory('plex', 'homeserver', 50);
      expect(records).toHaveLength(2);
      expect(records[0].id).toBe(2);
      expect(records[1].id).toBe(1);
    });
  });

  describe('deduplicatePending', () => {
    it('deletes older pending deploys for the same stack and host, keeping the latest', async () => {
      mock.pushResult([]);
      await repo.deduplicatePending('plex', 'homeserver', 42);

      expect(mock.queries[0].sql).toContain('DELETE FROM deploy_history');
      expect(mock.queries[0].params).toEqual(['plex', 'homeserver', 'pending', 42]);
    });
  });

  describe('getPendingDeploys', () => {
    it('returns pending deploys ordered by created_at asc', async () => {
      mock.pushResult([
        {
          id: '5', stack: 'plex', host: 'homeserver', commit_sha: 'abc',
          compose_hash: 'h1', env_hash: 'h2', status: 'pending',
          trigger: 'git_push', logs: null, created_at: new Date('2026-01-01'),
        },
      ]);

      const records = await repo.getPendingDeploys();
      expect(records).toHaveLength(1);
      expect(records[0].id).toBe(5);
      expect(records[0].status).toBe('pending');
    });
  });

  describe('getLatestDeployPerStack', () => {
    it('returns an empty array when no deploys exist', async () => {
      mock.pushResult([]);
      const records = await repo.getLatestDeployPerStack();
      expect(records).toHaveLength(0);
    });

    it('returns one record per stack with DISTINCT ON semantics', async () => {
      mock.pushResult([
        {
          id: '10', stack: 'plex', host: 'homeserver', commit_sha: 'sha1',
          compose_hash: 'h1', env_hash: 'h2', status: 'succeeded',
          trigger: 'git_push', logs: null, created_at: new Date('2026-01-02'),
        },
        {
          id: '20', stack: 'traefik', host: 'homeserver', commit_sha: 'sha2',
          compose_hash: 'h3', env_hash: 'h4', status: 'failed',
          trigger: 'ui', logs: 'error', created_at: new Date('2026-01-01'),
        },
      ]);

      const records = await repo.getLatestDeployPerStack();
      expect(records).toHaveLength(2);
      expect(records[0].id).toBe(10);
      expect(records[0].stack).toBe('plex');
      expect(records[0].status).toBe('succeeded');
      expect(records[1].id).toBe(20);
      expect(records[1].stack).toBe('traefik');
      expect(records[1].status).toBe('failed');
    });

    it('uses DISTINCT ON (stack, host) ordered by stack, host, created_at DESC', async () => {
      mock.pushResult([]);
      await repo.getLatestDeployPerStack();
      expect(mock.queries[0].sql).toContain('DISTINCT ON (stack, host)');
      expect(mock.queries[0].sql).toContain('ORDER BY stack, host, created_at DESC');
    });
  });

  describe('notifyStackChange', () => {
    it('sends JSON NOTIFY with type discriminator', async () => {
      await repo.notifyStackChange('plex', 'homeserver');

      expect(mock.queries).toHaveLength(1);
      expect(mock.queries[0].sql).toContain("pg_notify('deploy_change'");
      expect(mock.queries[0].params).toEqual([JSON.stringify({ type: 'deploy_changed', stack: 'plex', host: 'homeserver' })]);
    });
  });

  describe('recoverStuckDeploys', () => {
    it('returns an empty array when no deploys are stuck', async () => {
      mock.pushResult([]);
      const rows = await repo.recoverStuckDeploys('boom');
      expect(rows).toHaveLength(0);
      const sql = mock.queries[0].sql;
      expect(sql).toContain('UPDATE deploy_history');
      expect(sql).toContain("SET status = 'failed'");
      expect(sql).toContain('logs = $1');
      expect(sql).toContain("status IN ('pending', 'in_progress')");
      expect(sql).toContain('RETURNING id, stack, host');
      expect(mock.queries[0].params).toEqual(['boom']);
    });

    it('returns the recovered rows with Number-coerced ids', async () => {
      mock.pushResult([
        { id: '7', stack: 'plex', host: 'homeserver' },
        { id: '8', stack: 'traefik', host: 'other' },
      ]);
      const rows = await repo.recoverStuckDeploys('crashed');
      expect(rows).toEqual([
        { id: 7, stack: 'plex', host: 'homeserver' },
        { id: 8, stack: 'traefik', host: 'other' },
      ]);
    });
  });

  describe('timeoutStuckDeploys', () => {
    it('returns an empty array when no deploys are overdue', async () => {
      mock.pushResult([]);
      const rows = await repo.timeoutStuckDeploys(30, 'timed out');
      expect(rows).toHaveLength(0);
      const sql = mock.queries[0].sql;
      expect(sql).toContain('UPDATE deploy_history');
      expect(sql).toContain("SET status = 'failed'");
      expect(sql).toContain('logs = $2');
      expect(sql).toContain("status = 'in_progress'");
      expect(sql).toContain('make_interval(mins => $1)');
      expect(sql).toContain('RETURNING id, stack, host');
      expect(mock.queries[0].params).toEqual([30, 'timed out']);
    });

    it('returns the timed-out rows with Number-coerced ids', async () => {
      mock.pushResult([
        { id: '42', stack: 'plex', host: 'homeserver' },
      ]);
      const rows = await repo.timeoutStuckDeploys(15, 'slow');
      expect(rows).toEqual([
        { id: 42, stack: 'plex', host: 'homeserver' },
      ]);
    });
  });
});
