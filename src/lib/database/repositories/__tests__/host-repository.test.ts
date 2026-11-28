import { describe, it, expect, beforeEach, spyOn } from 'bun:test';
import { HostRepository } from '../host-repository';
import { MAX_FAILURE_DETAIL_LENGTH } from '@/lib/errors/host-failure-copy';
import type { CreateHostInput, HostHealthVerdict } from '../host-repository';

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
  id: 1,
  name: 'homeserver',
  agent_url: 'http://192.168.1.10:9090',
  capabilities: { docker: true, zfs: true },
  agent_version: '0.1.0',
  agent_image: 'ghcr.io/jaredglaser/homelab-manager-agent:dev',
  agent_image_tag: 'dev',
  agent_image_digest: 'sha256:' + 'a'.repeat(64),
  agent_out_of_date: false,
  status: 'healthy',
  created_at: new Date('2026-01-01T00:00:00Z'),
  updated_at: new Date('2026-01-01T00:00:00Z'),
  last_swept_at: new Date('2026-03-01T00:00:00Z'),
  agent_update_state: null,
  agent_update_result: null,
  agent_update_at: null,
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
      expect(result.capabilities).toEqual({ docker: true, zfs: true });
      expect(result.agentVersion).toBe('0.1.0');
      expect(result.agentImage).toBe('ghcr.io/jaredglaser/homelab-manager-agent:dev');
      expect(result.agentImageTag).toBe('dev');
      expect(result.agentImageDigest).toBe('sha256:' + 'a'.repeat(64));
      expect(result.agentOutOfDate).toBe(false);
      expect(result.lastSweptAt).toEqual(new Date('2026-03-01T00:00:00Z'));
      expect(mock.queries[0].sql).toContain('INSERT INTO managed_hosts');
      expect(mock.queries[0].sql).toContain('RETURNING');
      expect(mock.queries[0].params).toContain('homeserver');
    });

    it('insert returns only the generated id for deploy callers', async () => {
      mock.pushResult([{ id: 5 }]);

      const id = await repo.insert({
        name: 'newhost',
        agentUrl: 'http://agent:9090',
        capabilities: { docker: true },
      });

      expect(id).toBe(5);
      expect(typeof id).toBe('number');
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
      expect(result[0].capabilities).toEqual({ docker: true, zfs: true });
      expect(result[0].agentOutOfDate).toBe(false);
      expect(result[0].agentImageDigest).toBe('sha256:' + 'a'.repeat(64));
    });

    it('maps the recorded failure columns, and a row that has none to null', async () => {
      mock.pushResult([
        { ...sampleRow, name: 'down', failure_code: 'awaiting-enrollment', failure_detail: 'plain HTTP' },
        { ...sampleRow, id: 2, name: 'fresh' },
      ]);

      const [down, fresh] = await repo.findAll();

      expect(down.failure).toEqual({ code: 'awaiting-enrollment', detail: 'plain HTTP' });
      expect(fresh.failure).toBeNull();
    });

    it('getAll returns the camelCase host shape', async () => {
      mock.pushResult([sampleRow]);

      const result = await repo.getAll();

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        id: 1,
        name: 'homeserver',
        agentUrl: 'http://192.168.1.10:9090',
        capabilities: { docker: true, zfs: true },
        agentVersion: '0.1.0',
        agentImage: 'ghcr.io/jaredglaser/homelab-manager-agent:dev',
        agentImageTag: 'dev',
        agentImageDigest: 'sha256:' + 'a'.repeat(64),
        agentOutOfDate: false,
        lastSweptAt: new Date('2026-03-01T00:00:00Z'),
      });
    });

    it('maps a row that carries no agent image to nulls', async () => {
      mock.pushResult([{ ...sampleRow, agent_image: null, agent_image_tag: null }]);

      const result = await repo.getAll();

      expect(result[0].agentImage).toBeNull();
      expect(result[0].agentImageTag).toBeNull();
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

    it('getByName delegates to findByName', async () => {
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

  describe('updateHealth', () => {
    it('writes the status, the failure cause and updated_at in one statement, scoped to the probed URL', async () => {
      mock.pushResult([]); // UPDATE returns no rows
      await repo.updateHealth(
        1,
        { status: 'unhealthy', failure: { code: 'unreachable', detail: 'Agent returned status 502' } },
        'http://192.168.1.10:9090',
      );
      expect(mock.queries[0].sql).toContain('UPDATE managed_hosts');
      expect(mock.queries[0].sql).toContain('updated_at');
      expect(mock.queries[0].sql).toContain('agent_url = $5');
      expect(mock.queries[0].params).toEqual(['unhealthy', 'unreachable', 'Agent returned status 502', 1, 'http://192.168.1.10:9090']);
    });

    it('guards a pending verdict so it only lands on a row that is still pending', async () => {
      mock.pushResult([]);
      await repo.updateHealth(
        1,
        { status: 'pending', failure: { code: 'offline', detail: null } },
        'http://192.168.1.10:9090',
      );
      expect(mock.queries[0].sql).toContain("($1::text <> 'pending' OR status = 'pending')");
      expect(mock.queries[0].params[0]).toBe('pending');
    });

    it('cuts a failure detail that exceeds the stored limit', async () => {
      mock.pushResult([]);
      await repo.updateHealth(
        1,
        { status: 'unhealthy', failure: { code: 'offline', detail: 'x'.repeat(MAX_FAILURE_DETAIL_LENGTH + 100) } },
        'http://192.168.1.10:9090',
      );
      expect(mock.queries[0].params[2]).toBe('x'.repeat(MAX_FAILURE_DETAIL_LENGTH));
    });

    it('admits a pending verdict with a cause, and forbids a healthy or causeless unhealthy one', () => {
      const pending: HostHealthVerdict = { status: 'pending', failure: { code: 'offline', detail: null } };
      // @ts-expect-error a healthy status cannot carry a failure
      const healthyWithCause: HostHealthVerdict = { status: 'healthy', failure: { code: 'offline', detail: null } };
      // @ts-expect-error an unhealthy status must name its cause
      const unhealthyWithoutCause: HostHealthVerdict = { status: 'unhealthy', failure: null };

      expect([pending, healthyWithCause, unhealthyWithoutCause]).toHaveLength(3);
    });

    it('clears the failure cause on a healthy verdict', async () => {
      mock.pushResult([]);
      await repo.updateHealth(1, { status: 'healthy', failure: null }, 'http://192.168.1.10:9090');
      expect(mock.queries[0].params).toEqual(['healthy', null, null, 1, 'http://192.168.1.10:9090']);
    });
  });


  describe('updateAgentInfo', () => {
    it('updates the agent_version field', async () => {
      mock.pushResult([]);
      await repo.updateAgentInfo(1, { version: '0.2.0' });
      expect(mock.queries[0].sql).toContain('UPDATE managed_hosts');
      expect(mock.queries[0].sql).toContain('agent_version = $1');
      expect(mock.queries[0].sql).toContain('updated_at = NOW()');
      expect(mock.queries[0].sql).toContain('WHERE id = $2');
      expect(mock.queries[0].params).toEqual(['0.2.0', 1]);
    });

    it('updates the image columns alongside the version', async () => {
      mock.pushResult([]);
      await repo.updateAgentInfo(1, {
        version: '0.2.0',
        image: 'ghcr.io/jaredglaser/homelab-manager-agent:dev',
        imageTag: 'dev',
      });
      expect(mock.queries[0].sql).toContain('agent_image = $2');
      expect(mock.queries[0].sql).toContain('agent_image_tag = $3');
      expect(mock.queries[0].sql).toContain('WHERE id = $4');
      expect(mock.queries[0].params).toEqual([
        '0.2.0',
        'ghcr.io/jaredglaser/homelab-manager-agent:dev',
        'dev',
        1,
      ]);
    });

    it('clears the image columns when passed null', async () => {
      mock.pushResult([]);
      await repo.updateAgentInfo(1, { image: null, imageTag: null });
      expect(mock.queries[0].sql).toContain('WHERE id = $3');
      expect(mock.queries[0].params).toEqual([null, null, 1]);
    });

    it('leaves omitted fields untouched', async () => {
      mock.pushResult([]);
      await repo.updateAgentInfo(1, { imageTag: 'dev' });
      expect(mock.queries[0].sql).toContain('agent_image_tag = $1');
      expect(mock.queries[0].sql).toContain('WHERE id = $2');
      expect(mock.queries[0].sql).not.toContain('agent_version');
      expect(mock.queries[0].sql).not.toContain('agent_image =');
    });

    it('issues no query when given nothing to set', async () => {
      await repo.updateAgentInfo(1, {});
      expect(mock.queries).toHaveLength(0);
    });

    it('writes the digest and the out-of-date verdict', async () => {
      mock.pushResult([]);
      await repo.updateAgentInfo(1, { imageDigest: 'sha256:' + 'a'.repeat(64), outOfDate: true });
      expect(mock.queries[0].sql).toContain('agent_image_digest = $1');
      expect(mock.queries[0].sql).toContain('agent_out_of_date = $2');
      expect(mock.queries[0].params).toEqual(['sha256:' + 'a'.repeat(64), true, 1]);
    });
  });

  describe('updateLastSweptAt', () => {
    it('stamps last_swept_at without touching updated_at', async () => {
      const at = new Date('2026-03-01T00:00:00Z');
      await repo.updateLastSweptAt(1, at);
      expect(mock.queries[0].sql).toContain('last_swept_at = $1');
      expect(mock.queries[0].sql).not.toContain('updated_at');
      expect(mock.queries[0].params).toEqual([at, 1]);
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

  describe('change notifications', () => {
    function pickNotify(mockObj: ReturnType<typeof createMockPool>) {
      return mockObj.queries.filter((q) => q.sql.includes('pg_notify'));
    }

    it('emits add notify on create', async () => {
      mock.pushResult([sampleRow]);
      await repo.create({ name: 'homeserver', agentUrl: 'http://x:9090' });
      const notifies = pickNotify(mock);
      expect(notifies).toHaveLength(1);
      expect(notifies[0].params[0]).toBe('managed_hosts_change');
      expect(JSON.parse(notifies[0].params[1] as string)).toEqual({
        op: 'add',
        name: 'homeserver',
      });
    });

    it('emits add notify on insert', async () => {
      mock.pushResult([{ id: 1 }]);
      await repo.insert({ name: 'host2', agentUrl: 'http://x:9090' });
      const notifies = pickNotify(mock);
      expect(notifies).toHaveLength(1);
      expect(JSON.parse(notifies[0].params[1] as string)).toEqual({
        op: 'add',
        name: 'host2',
      });
    });

    it('emits update notify on update', async () => {
      mock.pushResult([sampleRow]);
      await repo.update(1, { name: 'renamed' });
      const notifies = pickNotify(mock);
      expect(notifies).toHaveLength(1);
      expect(JSON.parse(notifies[0].params[1] as string)).toEqual({
        op: 'update',
        name: 'homeserver',
      });
    });

    it('emits remove notify on delete when row exists', async () => {
      mock.pushResult([{ name: 'homeserver' }]);
      await repo.delete(1);
      const notifies = pickNotify(mock);
      expect(notifies).toHaveLength(1);
      expect(JSON.parse(notifies[0].params[1] as string)).toEqual({
        op: 'remove',
        name: 'homeserver',
      });
    });

    it('skips notify on delete when row does not exist', async () => {
      mock.pushResult([]);
      await repo.delete(999);
      expect(pickNotify(mock)).toHaveLength(0);
    });

    it('does not notify on metadata-only updates (status/version)', async () => {
      mock.pushResult([]);
      mock.pushResult([]);
      await repo.updateHealth(1, { status: 'healthy', failure: null }, 'http://192.168.1.10:9090');
      await repo.updateAgentInfo(1, { version: '0.2.0' });
      expect(pickNotify(mock)).toHaveLength(0);
    });
  });

  describe('agent update state', () => {
    const STARTED = new Date('2026-11-27T10:00:00Z');
    const ENDED = new Date('2026-11-27T10:00:40Z');

    function notifies() {
      return mock.queries.filter((q) => q.sql.includes('pg_notify'));
    }

    it('reads a running, a finished and an interrupted update from the row', async () => {
      mock.pushResult([
        { ...sampleRow, id: 1, agent_update_state: 'running', agent_update_at: STARTED },
        {
          ...sampleRow,
          id: 2,
          agent_update_state: 'done',
          agent_update_at: ENDED,
          agent_update_result: { healthy: false, code: 'agent_did_not_restart', message: 'Agent did not restart after update' },
        },
        { ...sampleRow, id: 3, agent_update_state: 'interrupted', agent_update_at: ENDED },
        { ...sampleRow, id: 4 },
      ]);

      const hosts = await repo.findAll();

      expect(hosts.map((h) => h.agentUpdate)).toEqual([
        { state: 'running', at: STARTED },
        { state: 'done', at: ENDED, result: { healthy: false, code: 'agent_did_not_restart', message: 'Agent did not restart after update' } },
        { state: 'interrupted', at: ENDED },
        null,
      ]);
    });

    it('reads a state or result this build does not know as no update, so the rest of the row still loads', async () => {
      const errorSpy = spyOn(console, 'error').mockImplementation(() => undefined);
      try {
        mock.pushResult([
          { ...sampleRow, id: 1, agent_update_state: 'paused', agent_update_at: STARTED },
          { ...sampleRow, id: 2, agent_update_state: 'done', agent_update_at: ENDED, agent_update_result: { healthy: false, code: 'from_a_newer_build', message: '' } },
        ]);
        const hosts = await repo.findAll();
        expect(hosts.map((h) => [h.name, h.agentUpdate])).toEqual([['homeserver', null], ['homeserver', null]]);
      } finally {
        errorSpy.mockRestore();
      }
    });

    it('claims a host only while no live update is running on it, and announces the claim on the inventory channel', async () => {
      const runningBefore = new Date('2026-11-27T09:50:00Z');
      mock.pushResult([{ id: 1 }]);
      expect(await repo.claimAgentUpdate(1, STARTED, runningBefore)).toBe(true);
      expect(mock.queries[0].sql).toContain("(agent_update_state IS DISTINCT FROM 'running' OR agent_update_at < $3)");
      expect(mock.queries[0].params).toEqual([1, STARTED, runningBefore]);
      expect(notifies()).toHaveLength(1);
      expect(notifies()[0].params).toEqual(['agent_inventory_change', JSON.stringify({ hostIds: [1] })]);
    });

    it('reports a refused claim without announcing anything', async () => {
      mock.pushResult([]);
      expect(await repo.claimAgentUpdate(1, STARTED, STARTED)).toBe(false);
      expect(notifies()).toHaveLength(0);
    });

    it('settles only the update that started at the given time and stores its result', async () => {
      mock.pushResult([{ id: 1 }]);
      const result = { healthy: true as const, outcome: 'updated' as const, version: '2.0.0' };
      await repo.settleAgentUpdate(1, STARTED, { state: 'done', result }, ENDED);
      expect(mock.queries[0].sql).toContain("agent_update_state = 'running' AND agent_update_at = $2");
      expect(mock.queries[0].params).toEqual([1, STARTED, 'done', JSON.stringify(result), ENDED]);
      expect(notifies()).toHaveLength(1);
    });

    it('cuts a stored refusal message to the failure detail limit, since every viewer receives it', async () => {
      mock.pushResult([{ id: 1 }]);
      const result = { healthy: false as const, code: 'agent_reported_error' as const, message: 'x'.repeat(MAX_FAILURE_DETAIL_LENGTH + 300) };
      await repo.settleAgentUpdate(1, STARTED, { state: 'done', result }, ENDED);
      expect(JSON.parse(mock.queries[0].params[3] as string)).toEqual({ ...result, message: 'x'.repeat(MAX_FAILURE_DETAIL_LENGTH) });
    });

    it('stores an errored update with no result', async () => {
      mock.pushResult([{ id: 1 }]);
      await repo.settleAgentUpdate(1, STARTED, { state: 'errored' }, ENDED);
      expect(mock.queries[0].params).toEqual([1, STARTED, 'errored', null, ENDED]);
    });

    it('does not announce a settle that matched no running update', async () => {
      mock.pushResult([]);
      await repo.settleAgentUpdate(1, STARTED, { state: 'interrupted' }, ENDED);
      expect(notifies()).toHaveLength(0);
    });

    it('marks as interrupted only the updates that started before the given time', async () => {
      mock.pushResult([{ id: 2 }, { id: 5 }]);
      expect(await repo.interruptAgentUpdates(STARTED, ENDED)).toEqual([2, 5]);
      expect(mock.queries[0].sql).toContain("SET agent_update_state = 'interrupted'");
      expect(mock.queries[0].sql).toContain("WHERE agent_update_state = 'running' AND agent_update_at < $1");
      expect(mock.queries[0].params).toEqual([STARTED, ENDED]);
      expect(notifies()[0].params).toEqual(['agent_inventory_change', JSON.stringify({ hostIds: [2, 5] })]);
    });

    it('leaves the update columns alone when the health sweep writes the row', async () => {
      await repo.updateHealth(1, { status: 'healthy', failure: null }, 'http://192.168.1.10:9090');
      await repo.updateAgentInfo(1, { version: '0.2.0', imageDigest: 'sha256:' + 'c'.repeat(64), outOfDate: true });
      await repo.updateLastSweptAt(1, ENDED);
      for (const query of mock.queries) expect(query.sql).not.toContain('agent_update_');
    });
  });

  describe('status', () => {
    it('refuses a status outside the CHECK constraint', async () => {
      const errorSpy = spyOn(console, 'error').mockImplementation(() => undefined);
      mock.pushResult([{ ...sampleRow, status: 'degraded' }]);

      await expect(repo.findById(1)).rejects.toThrow('Unrecognized managed_hosts.status value');
      errorSpy.mockRestore();
    });
  });
});
