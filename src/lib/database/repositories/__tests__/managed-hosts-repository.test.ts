import { describe, it, expect, beforeEach } from 'bun:test';
import { ManagedHostsRepository } from '../managed-hosts-repository';
import { createMockPool } from '@/lib/test/mock-pool';

describe('ManagedHostsRepository', () => {
  let repo: ManagedHostsRepository;
  let mock: ReturnType<typeof createMockPool>;

  beforeEach(() => {
    mock = createMockPool();
    repo = new ManagedHostsRepository(mock.pool);
  });

  describe('getByName', () => {
    it('returns null when host does not exist', async () => {
      mock.pushResult([]);
      const result = await repo.getByName('nonexistent');
      expect(result).toBeNull();
    });

    it('returns the host with Number-coerced id', async () => {
      mock.pushResult([{
        id: '1',
        name: 'homeserver',
        agent_url: 'http://agent:9090',
        capabilities: { docker: true },
        agent_version: '0.1.0',
        status: 'healthy',
        created_at: new Date('2026-01-01'),
      }]);

      const result = await repo.getByName('homeserver');
      expect(result).not.toBeNull();
      expect(result!.id).toBe(1);
      expect(result!.name).toBe('homeserver');
      expect(result!.agentUrl).toBe('http://agent:9090');
    });
  });

  describe('getAll', () => {
    it('returns all hosts', async () => {
      mock.pushResult([
        {
          id: '1', name: 'host1', agent_url: 'http://a:9090',
          capabilities: { docker: true },
          agent_version: null, status: 'healthy', created_at: new Date(),
        },
        {
          id: '2', name: 'host2', agent_url: 'http://b:9090',
          capabilities: { docker: true, zfs: true },
          agent_version: '0.2.0', status: 'pending', created_at: new Date(),
        },
      ]);

      const result = await repo.getAll();
      expect(result).toHaveLength(2);
      expect(result[0].id).toBe(1);
      expect(result[1].id).toBe(2);
    });
  });

  describe('insert', () => {
    it('inserts a host and returns the id', async () => {
      mock.pushResult([{ id: '5' }]);
      const id = await repo.insert({
        name: 'newhost',
        agentUrl: 'http://agent:9090',
        capabilities: { docker: true },
      });

      expect(id).toBe(5);
      expect(mock.queries[0].sql).toContain('INSERT INTO managed_hosts');
      expect(mock.queries[0].params).toContain(JSON.stringify({ docker: true }));
    });
  });

  describe('updateStatus', () => {
    it('updates host status', async () => {
      await repo.updateStatus(1, 'healthy');

      expect(mock.queries[0].sql).toContain('UPDATE managed_hosts');
      expect(mock.queries[0].params).toEqual(['healthy', 1]);
    });
  });

  describe('updateAgentVersion', () => {
    it('updates agent version', async () => {
      await repo.updateAgentVersion(1, '0.2.0');

      expect(mock.queries[0].sql).toContain('UPDATE managed_hosts');
      expect(mock.queries[0].params).toEqual(['0.2.0', 1]);
    });
  });
});
