import { describe, it, expect, beforeEach } from 'bun:test';
import { StackStatusRepository } from '../stack-status-repository';
import { createMockPool } from '@/lib/test/mock-pool';
import type { StackContainer } from '@/types/stacks';

const containers: StackContainer[] = [
  { id: 'abc123', name: 'plex', status: 'running', image: 'plexinc/pms-docker:latest' },
  { id: 'def456', name: 'plex-db', status: 'running', image: 'postgres:16' },
];

describe('StackStatusRepository', () => {
  let repo: StackStatusRepository;
  let mock: ReturnType<typeof createMockPool>;

  beforeEach(() => {
    mock = createMockPool();
    repo = new StackStatusRepository(mock.pool);
  });

  describe('upsertStackStatus', () => {
    it('issues INSERT ... ON CONFLICT UPDATE with correct parameters', async () => {
      mock.pushResult([]);
      await repo.upsertStackStatus('plex', 'homeserver', containers);

      expect(mock.queries).toHaveLength(1);
      expect(mock.queries[0].sql).toContain('INSERT INTO stack_status');
      expect(mock.queries[0].sql).toContain('ON CONFLICT (stack, host)');
      expect(mock.queries[0].sql).toContain('DO UPDATE SET containers');
      expect(mock.queries[0].params).toEqual(['plex', 'homeserver', JSON.stringify(containers)]);
    });

    it('accepts an empty container list', async () => {
      mock.pushResult([]);
      await repo.upsertStackStatus('empty-stack', 'homeserver', []);

      expect(mock.queries[0].params).toEqual(['empty-stack', 'homeserver', '[]']);
    });
  });

  describe('getAll', () => {
    it('returns all rows ordered by stack and host', async () => {
      const now = new Date();
      mock.pushResult([
        { stack: 'plex', host: 'homeserver', containers, updated_at: now },
        { stack: 'traefik', host: 'homeserver', containers: [], updated_at: now },
      ]);

      const rows = await repo.getAll();
      expect(rows).toHaveLength(2);
      expect(rows[0].stack).toBe('plex');
      expect(rows[1].stack).toBe('traefik');
      expect(mock.queries[0].sql).toContain('ORDER BY stack, host');
      expect(mock.queries[0].params).toEqual([]);
    });

    it('returns an empty array when no rows exist', async () => {
      mock.pushResult([]);
      const rows = await repo.getAll();
      expect(rows).toEqual([]);
    });
  });

  describe('getByStackHost', () => {
    it('returns the matching row when it exists', async () => {
      const now = new Date();
      mock.pushResult([{ stack: 'plex', host: 'homeserver', containers, updated_at: now }]);

      const row = await repo.getByStackHost('plex', 'homeserver');
      expect(row).not.toBeNull();
      expect(row!.stack).toBe('plex');
      expect(row!.host).toBe('homeserver');
      expect(row!.containers).toBe(containers);
      expect(mock.queries[0].params).toEqual(['plex', 'homeserver']);
    });

    it('returns null when the row does not exist', async () => {
      mock.pushResult([]);
      const row = await repo.getByStackHost('missing', 'homeserver');
      expect(row).toBeNull();
    });
  });

  describe('getByHost', () => {
    it('returns all stacks for a host ordered by stack name', async () => {
      const now = new Date();
      mock.pushResult([
        { stack: 'plex', host: 'homeserver', containers, updated_at: now },
        { stack: 'traefik', host: 'homeserver', containers: [], updated_at: now },
      ]);

      const rows = await repo.getByHost('homeserver');
      expect(rows).toHaveLength(2);
      expect(rows[0].stack).toBe('plex');
      expect(rows[1].stack).toBe('traefik');
      expect(mock.queries[0].sql).toContain('WHERE host = $1');
      expect(mock.queries[0].sql).toContain('ORDER BY stack');
      expect(mock.queries[0].params).toEqual(['homeserver']);
    });

    it('returns an empty array when the host has no stacks', async () => {
      mock.pushResult([]);
      const rows = await repo.getByHost('empty-host');
      expect(rows).toEqual([]);
    });
  });

  describe('deleteByStackHost', () => {
    it('issues DELETE with correct parameters', async () => {
      mock.pushResult([]);
      await repo.deleteByStackHost('plex', 'homeserver');

      expect(mock.queries).toHaveLength(1);
      expect(mock.queries[0].sql).toContain('DELETE FROM stack_status');
      expect(mock.queries[0].sql).toContain('WHERE stack = $1 AND host = $2');
      expect(mock.queries[0].params).toEqual(['plex', 'homeserver']);
    });
  });
});
