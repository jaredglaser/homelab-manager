import { describe, it, expect } from 'bun:test';
import {
  listContainerSnapshot,
  getContainerCountsByHost,
  getContainerSnapshot,
  getContainerEvents,
  getDeployHistoryForStack,
} from '@/lib/mcp/queries';

function createMockPool(rows: Record<string, unknown>[] = []) {
  const queryResults: Record<string, unknown>[][] = [];
  const calls: { sql: string; params?: unknown[] }[] = [];
  return {
    pool: {
      query: async (sql: string, params?: unknown[]) => {
        calls.push({ sql, params });
        const result = queryResults.length > 0 ? queryResults.shift()! : rows;
        return { rows: result };
      },
    } as never,
    pushResult(r: Record<string, unknown>[]) {
      queryResults.push(r);
    },
    calls,
  };
}

const snapshotDbRow = {
  at: new Date('2026-08-14T22:10:04.221Z'),
  host: 'nuc1',
  container_id: '9f2c1ab34de5',
  event_type: 'upsert',
  state: 'running',
  name: 'plex',
  image: 'lscr.io/linuxserver/plex:1.41.0',
  labels: { 'com.docker.compose.project': 'media' },
  ports: [],
  mounts: [],
  compose_project: 'media',
  service_key: 'plex',
  started_at: new Date('2026-08-14T22:10:03.000Z'),
  finished_at: null,
  exit_code: null,
};

describe('listContainerSnapshot', () => {
  it('maps rows and applies host/state/stack/name filters', async () => {
    const mock = createMockPool();
    mock.pushResult([snapshotDbRow]);

    const rows = await listContainerSnapshot(mock.pool, {
      host: 'nuc1',
      state: 'running',
      stack: 'media',
      nameContains: 'ple',
      limit: 50,
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ host: 'nuc1', containerId: '9f2c1ab34de5', eventType: 'upsert', state: 'running' });
    const sql = mock.calls[0]!.sql;
    expect(sql).toContain('latest.host = $1');
    expect(sql).toContain('latest.state = $2');
    expect(sql).toContain('latest.compose_project = $3');
    expect(sql).toContain('latest.name ILIKE $4');
    expect(mock.calls[0]!.params).toEqual(['nuc1', 'running', 'media', '%ple%', 50]);
  });

  it('applies a keyset cursor derived from afterEntityId', async () => {
    const mock = createMockPool();
    mock.pushResult([]);

    await listContainerSnapshot(mock.pool, { afterEntityId: 'nuc1/deadbeefcafe', limit: 10 });

    expect(mock.calls[0]!.sql).toContain('(latest.host, latest.container_id) > ($1, $2)');
    expect(mock.calls[0]!.params).toEqual(['nuc1', 'deadbeefcafe', 10]);
  });

  it('only ever fetches upsert rows', async () => {
    const mock = createMockPool();
    mock.pushResult([]);

    await listContainerSnapshot(mock.pool, { limit: 10 });

    expect(mock.calls[0]!.sql).toContain(`latest.event_type = 'upsert'`);
  });
});

describe('getContainerCountsByHost', () => {
  it('aggregates counts per host', async () => {
    const mock = createMockPool();
    mock.pushResult([
      { host: 'nuc1', count: '2' },
      { host: 'nas1', count: '5' },
    ]);

    const counts = await getContainerCountsByHost(mock.pool);

    expect(counts).toEqual(new Map([['nuc1', 2], ['nas1', 5]]));
    expect(mock.calls[0]!.sql).toContain(`latest.event_type = 'upsert'`);
    expect(mock.calls[0]!.sql).toContain('GROUP BY latest.host');
  });

  it('returns an empty map when there are no containers', async () => {
    const mock = createMockPool();
    mock.pushResult([]);

    expect(await getContainerCountsByHost(mock.pool)).toEqual(new Map());
  });
});

describe('getContainerSnapshot', () => {
  it('matches by host and a container-id prefix', async () => {
    const mock = createMockPool();
    mock.pushResult([snapshotDbRow]);

    const row = await getContainerSnapshot(mock.pool, 'nuc1', '9f2c1ab34de5');

    expect(row).toMatchObject({ host: 'nuc1', containerId: '9f2c1ab34de5' });
    expect(mock.calls[0]!.sql).toContain('container_id LIKE $2');
    expect(mock.calls[0]!.params).toEqual(['nuc1', '9f2c1ab34de5']);
  });

  it('returns null when nothing matches', async () => {
    const mock = createMockPool();
    mock.pushResult([]);

    expect(await getContainerSnapshot(mock.pool, 'nuc1', 'missing')).toBeNull();
  });

  it('maps a destroy row without upsert-only fields', async () => {
    const mock = createMockPool();
    mock.pushResult([{ at: new Date('2026-08-15T01:00:00.000Z'), host: 'nuc1', container_id: '9f2c1ab34de5', event_type: 'destroy' }]);

    const row = await getContainerSnapshot(mock.pool, 'nuc1', '9f2c1ab34de5');

    expect(row).toMatchObject({ eventType: 'destroy', state: null, name: null, image: null });
  });
});

describe('getContainerEvents', () => {
  it('queries a window and maps event rows newest first', async () => {
    const mock = createMockPool();
    mock.pushResult([
      {
        at: new Date('2026-08-15T11:58:40.010Z'),
        event_type: 'upsert',
        state: 'restarting',
        name: 'plex',
        image: 'lscr.io/linuxserver/plex:1.41.0',
        compose_project: 'media',
        service_key: 'plex',
        started_at: new Date('2026-08-15T11:58:39.000Z'),
        finished_at: null,
        exit_code: null,
      },
    ]);

    const from = new Date('2026-08-14T00:00:00Z');
    const to = new Date('2026-08-15T12:00:00Z');
    const rows = await getContainerEvents(mock.pool, 'nuc1', '9f2c1ab34de5', from, to, 50);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ eventType: 'upsert', state: 'restarting', composeProject: 'media' });
    expect(mock.calls[0]!.params).toEqual(['nuc1', '9f2c1ab34de5', from, to, 50]);
    expect(mock.calls[0]!.sql).toContain('ORDER BY at DESC');
  });
});

describe('getDeployHistoryForStack', () => {
  const deployDbRow = {
    id: '812',
    stack: 'media',
    host: 'nuc1',
    commit_sha: '3f9a1c7e',
    compose_hash: 'sha256:compose',
    env_hash: 'sha256:env',
    status: 'succeeded',
    trigger: 'git_push',
    action: 'deploy',
    force_recreate: false,
    logs: null,
    created_at: new Date('2026-08-15T11:57:02.881Z'),
    post_success: null,
  };

  it('filters by stack only when host is null', async () => {
    const mock = createMockPool();
    mock.pushResult([deployDbRow]);

    const records = await getDeployHistoryForStack(mock.pool, 'media', null, 11);

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ id: 812, stack: 'media', host: 'nuc1', forceRecreate: false });
    expect(mock.calls[0]!.sql).not.toContain('AND host');
    expect(mock.calls[0]!.params).toEqual(['media', 11]);
  });

  it('filters by stack and host when host is provided', async () => {
    const mock = createMockPool();
    mock.pushResult([deployDbRow]);

    await getDeployHistoryForStack(mock.pool, 'media', 'nuc1', 11);

    const call = mock.calls[0]!;
    expect(call.sql).toContain('AND host = $2');
    expect(call.params).toEqual(['media', 'nuc1', 11]);
  });

  it('coerces the bigint id and defaults a missing action', async () => {
    const mock = createMockPool();
    mock.pushResult([{ ...deployDbRow, id: '999', action: null }]);

    const [record] = await getDeployHistoryForStack(mock.pool, 'media', null, 1);

    expect(record!.id).toBe(999);
    expect(record!.action).toBe('deploy');
  });
});
