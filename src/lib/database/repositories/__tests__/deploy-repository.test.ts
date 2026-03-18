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
      });

      expect(id).toBe(42);
      expect(mock.queries[0].sql).toContain('INSERT INTO deploy_history');
      expect(mock.queries[0].params).toEqual([
        'plex', 'homeserver', 'abc123', 'hash1', 'hash2', 'pending', 'git_push',
      ]);
    });
  });

  describe('updateStatus', () => {
    it('updates status and logs for a deploy record', async () => {
      await repo.updateStatus(42, 'succeeded', 'deployment complete');

      expect(mock.queries[0].sql).toContain('UPDATE deploy_history');
      expect(mock.queries[0].params).toEqual([42, 'succeeded', 'deployment complete']);
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
    };

    it('returns the deploy id when no active deploy exists', async () => {
      mock.pushResult([{ id: '42' }]);
      const id = await repo.insertDeployIfNoActive(insertParams);
      expect(id).toBe(42);
    });

    it('returns null on unique constraint violation (code 23505)', async () => {
      // Override the pool to throw a unique violation
      const violationPool = {
        query: async () => {
          const err = new Error('duplicate key') as Error & { code: string };
          err.code = '23505';
          throw err;
        },
      } as any;
      const violationRepo = new DeployRepository(violationPool);

      const id = await violationRepo.insertDeployIfNoActive(insertParams);
      expect(id).toBeNull();
    });

    it('re-throws non-unique-violation errors', async () => {
      const errorPool = {
        query: async () => { throw new Error('connection lost'); },
      } as any;
      const errorRepo = new DeployRepository(errorPool);

      expect(errorRepo.insertDeployIfNoActive(insertParams)).rejects.toThrow('connection lost');
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
});
