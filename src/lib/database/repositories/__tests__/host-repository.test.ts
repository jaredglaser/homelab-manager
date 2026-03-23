import { describe, it, expect, beforeEach } from 'bun:test';
import { HostRepository } from '../host-repository';
import type { CreateHostInput } from '../host-repository';

function createMockPool() {
  const queries: { sql: string; params: unknown[] }[] = [];
  const queryResults: Record<string, unknown>[][] = [];
  return {
    pool: {
      query: async (sql: string, params?: unknown[]) => {
        queries.push({ sql, params: params ?? [] });
        const result = queryResults.length > 0 ? queryResults.shift()! : [];
        return { rows: result, rowCount: result.length };
      },
    } as any,
    queries,
    pushResult(r: Record<string, unknown>[]) {
      queryResults.push(r);
    },
  };
}

const sampleRow = {
  id: 1, // SERIAL (INT4) returns number from node-postgres (only BIGINT returns strings)
  name: 'homeserver',
  agent_url: 'http://192.168.1.10:9090',
  socket_proxy_url: 'tcp://192.168.1.10:2375',
  agent_version: '0.1.0',
  status: 'healthy',
  created_at: new Date('2026-01-01T00:00:00Z'),
  updated_at: new Date('2026-01-01T00:00:00Z'),
};

describe('HostRepository', () => {
  let repo: HostRepository;
  let mock: ReturnType<typeof createMockPool>;

  beforeEach(() => {
    mock = createMockPool();
    repo = new HostRepository(mock.pool);
  });

  describe('create', () => {
    it('inserts a host and returns it with the generated id', async () => {
      mock.pushResult([sampleRow]);

      const input: CreateHostInput = {
        name: 'homeserver',
        agent_url: 'http://192.168.1.10:9090',
        socket_proxy_url: 'tcp://192.168.1.10:2375',
      };

      const result = await repo.create(input);

      expect(result.id).toBe(1);
      expect(result.name).toBe('homeserver');
      expect(result.agent_url).toBe('http://192.168.1.10:9090');
      expect(result.status).toBe('healthy');
      expect(mock.queries[0].sql).toContain('INSERT INTO managed_hosts');
      expect(mock.queries[0].sql).toContain('RETURNING');
      expect(mock.queries[0].params).toContain('homeserver');
    });
  });

  describe('findAll', () => {
    it('returns empty array when no hosts exist', async () => {
      mock.pushResult([]);
      const result = await repo.findAll();
      expect(result).toEqual([]);
    });

    it('returns all hosts sorted by name', async () => {
      mock.pushResult([
        { ...sampleRow, name: 'alpha' },
        { ...sampleRow, id: 2, name: 'beta' },
      ]);

      const result = await repo.findAll();

      expect(result).toHaveLength(2);
      expect(result[0].name).toBe('alpha');
      expect(result[1].name).toBe('beta');
      expect(result[0].id).toBe(1);
      expect(result[1].id).toBe(2);
    });
  });

  describe('findByName', () => {
    it('returns null when host does not exist', async () => {
      mock.pushResult([]);
      const result = await repo.findByName('nonexistent');
      expect(result).toBeNull();
    });

    it('returns host when found', async () => {
      mock.pushResult([sampleRow]);
      const result = await repo.findByName('homeserver');
      expect(result).not.toBeNull();
      expect(result!.name).toBe('homeserver');
      expect(result!.id).toBe(1);
    });
  });

  describe('findById', () => {
    it('returns null when id does not exist', async () => {
      mock.pushResult([]);
      const result = await repo.findById(999);
      expect(result).toBeNull();
    });

    it('returns host when found', async () => {
      mock.pushResult([sampleRow]);
      const result = await repo.findById(1);
      expect(result).not.toBeNull();
      expect(result!.id).toBe(1);
    });
  });

  describe('updateStatus', () => {
    it('updates the status field and updated_at', async () => {
      mock.pushResult([]); // UPDATE returns no rows
      await repo.updateStatus(1, 'error');
      expect(mock.queries[0].sql).toContain('UPDATE managed_hosts');
      expect(mock.queries[0].sql).toContain('updated_at');
      expect(mock.queries[0].params).toContain('error');
      expect(mock.queries[0].params).toContain(1);
    });
  });

  describe('updateAgentVersion', () => {
    it('updates the agent_version field', async () => {
      mock.pushResult([]);
      await repo.updateAgentVersion(1, '0.2.0');
      expect(mock.queries[0].sql).toContain('UPDATE managed_hosts');
      expect(mock.queries[0].params).toContain('0.2.0');
      expect(mock.queries[0].params).toContain(1);
    });
  });

  describe('updateAgentUrl', () => {
    it('updates the agent_url field', async () => {
      mock.pushResult([]);
      await repo.updateAgentUrl(1, 'http://192.168.1.10:9090');
      expect(mock.queries[0].sql).toContain('UPDATE managed_hosts');
      expect(mock.queries[0].sql).toContain('agent_url');
      expect(mock.queries[0].params).toContain('http://192.168.1.10:9090');
      expect(mock.queries[0].params).toContain(1);
    });
  });

  describe('delete', () => {
    it('deletes the host by id', async () => {
      mock.pushResult([]);
      await repo.delete(1);
      expect(mock.queries[0].sql).toContain('DELETE FROM managed_hosts');
      expect(mock.queries[0].params).toContain(1);
    });
  });
});
