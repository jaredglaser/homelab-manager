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
  id: '1',
  name: 'homeserver',
  agent_url: 'http://192.168.1.10:9090',
  capabilities: { docker: true, zfs: true },
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
        agentUrl: 'http://192.168.1.10:9090',
        capabilities: { docker: true },
      };

      const result = await repo.create(input);

      expect(result.id).toBe(1);
      expect(result.name).toBe('homeserver');
      expect(result.agentUrl).toBe('http://192.168.1.10:9090');
      expect(result.status).toBe('healthy');
      expect(mock.queries[0].sql).toContain('INSERT INTO managed_hosts');
      expect(mock.queries[0].sql).toContain('RETURNING');
      expect(mock.queries[0].params).toContain('homeserver');
    });

    it('insert returns only the generated id for deploy callers', async () => {
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
      expect(result[0].agentUrl).toBe('http://192.168.1.10:9090');
    });

    it('getAll returns the canonical camelCase host shape', async () => {
      mock.pushResult([sampleRow]);

      const result = await repo.getAll();

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        id: 1,
        name: 'homeserver',
        agentUrl: 'http://192.168.1.10:9090',
        agentVersion: '0.1.0',
      });
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
      expect(result!.agentUrl).toBe('http://192.168.1.10:9090');
    });

    it('getByName delegates to the canonical camelCase lookup', async () => {
      mock.pushResult([sampleRow]);
      const result = await repo.getByName('homeserver');
      expect(result).not.toBeNull();
      expect(result!.agentUrl).toBe('http://192.168.1.10:9090');
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

  describe('update', () => {
    it('updates provided fields and returns the updated host', async () => {
      const updated = { ...sampleRow, name: 'renamed-host', agent_url: 'http://192.168.1.20:9090' };
      mock.pushResult([updated]);

      const result = await repo.update(1, { name: 'renamed-host', agentUrl: 'http://192.168.1.20:9090' });

      expect(result.name).toBe('renamed-host');
      expect(result.agentUrl).toBe('http://192.168.1.20:9090');
      expect(mock.queries[0].sql).toContain('UPDATE managed_hosts');
      expect(mock.queries[0].sql).toContain('RETURNING');
      expect(mock.queries[0].params).toContain('renamed-host');
      expect(mock.queries[0].params).toContain('http://192.168.1.20:9090');
      expect(mock.queries[0].params).toContain(1);
    });

    it('updates only name when only name is provided', async () => {
      mock.pushResult([{ ...sampleRow, name: 'new-name' }]);

      await repo.update(1, { name: 'new-name' });

      expect(mock.queries[0].sql).toContain('name = $1');
      expect(mock.queries[0].sql).not.toContain('agent_url');
      expect(mock.queries[0].params).toContain('new-name');
    });

    it('updates capabilities with updated_at and returns camelCase fields', async () => {
      mock.pushResult([{ ...sampleRow, capabilities: { docker: true } }]);

      const result = await repo.update(1, { capabilities: { docker: true } });

      expect(result.capabilities).toEqual({ docker: true });
      expect(mock.queries[0].sql).toContain('capabilities = $1');
      expect(mock.queries[0].sql).toContain('updated_at = NOW()');
      expect(mock.queries[0].params).toContain(JSON.stringify({ docker: true }));
    });

    it('returns existing host without issuing UPDATE when no fields provided', async () => {
      mock.pushResult([sampleRow]); // findById result

      const result = await repo.update(1, {});

      expect(result.id).toBe(1);
      expect(mock.queries[0].sql).toContain('SELECT');
    });

    it('throws when host id not found during update', async () => {
      mock.pushResult([]); // UPDATE returns no rows

      await expect(repo.update(999, { name: 'x' })).rejects.toThrow('not found');
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
