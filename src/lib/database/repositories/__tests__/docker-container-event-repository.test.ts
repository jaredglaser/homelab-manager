import { describe, it, expect, beforeEach } from 'bun:test';
import { DockerContainerEventRepository } from '../docker-container-event-repository';
import type { NewContainerEvent } from '../docker-container-event-repository';
import { createMockPool } from '@/lib/test/mock-pool';

const baseEvent: NewContainerEvent = {
  at: new Date('2026-04-16T10:00:00Z'),
  host: 'homeserver',
  containerId: 'abc123',
  eventType: 'upsert',
  state: 'running',
  name: 'plex',
  image: 'plexinc/pms-docker:latest',
  labels: { 'com.docker.compose.project': 'media', 'com.docker.compose.service': 'plex' },
  serviceKey: 'media/plex',
  startedAt: new Date('2026-04-16T09:50:00Z'),
  finishedAt: null,
  exitCode: null,
};

const dbRow = {
  at: new Date('2026-04-16T10:00:00Z'),
  host: 'homeserver',
  container_id: 'abc123',
  event_type: 'upsert',
  state: 'running',
  name: 'plex',
  image: 'plexinc/pms-docker:latest',
  labels: { 'com.docker.compose.project': 'media', 'com.docker.compose.service': 'plex' },
  compose_project: 'media',
  service_key: 'media/plex',
  started_at: new Date('2026-04-16T09:50:00Z'),
  finished_at: null,
  exit_code: null,
};

describe('DockerContainerEventRepository', () => {
  let repo: DockerContainerEventRepository;
  let mock: ReturnType<typeof createMockPool>;

  beforeEach(() => {
    mock = createMockPool();
    repo = new DockerContainerEventRepository(mock.pool);
  });

  describe('insert', () => {
    it('issues INSERT with correct columns and returns mapped row', async () => {
      mock.pushResult([dbRow]);

      const result = await repo.insert(baseEvent);

      expect(mock.queries).toHaveLength(1);
      expect(mock.queries[0].sql).toContain('INSERT INTO docker_container_events');
      expect(mock.queries[0].sql).toContain('RETURNING');
      expect(mock.queries[0].params).toEqual([
        baseEvent.at,
        'homeserver',
        'abc123',
        'upsert',
        'running',
        'plex',
        'plexinc/pms-docker:latest',
        JSON.stringify(baseEvent.labels),
        'media/plex',
        baseEvent.startedAt,
        null,
        null,
      ]);

      expect(result.containerId).toBe('abc123');
      expect(result.host).toBe('homeserver');
      expect(result.eventType).toBe('upsert');
      expect(result.state).toBe('running');
      expect(result.composeProject).toBe('media');
      expect(result.serviceKey).toBe('media/plex');
      expect(result.startedAt).toEqual(new Date('2026-04-16T09:50:00Z'));
      expect(result.finishedAt).toBeNull();
      expect(result.exitCode).toBeNull();
    });

    it('inserts a destroy event with null state', async () => {
      const destroyEvent: NewContainerEvent = {
        at: new Date(),
        host: 'homeserver',
        containerId: 'abc123',
        eventType: 'destroy',
        state: null,
        name: null,
        image: null,
        labels: {},
        serviceKey: null,
        startedAt: null,
        finishedAt: null,
        exitCode: null,
      };
      mock.pushResult([{ ...dbRow, event_type: 'destroy', state: null, name: null, image: null, labels: {}, compose_project: null, service_key: null, started_at: null }]);

      const result = await repo.insert(destroyEvent);

      expect(result.eventType).toBe('destroy');
      expect(result.state).toBeNull();
      expect(result.composeProject).toBeNull();
    });

    it('stores labels as JSON string parameter', async () => {
      mock.pushResult([dbRow]);
      await repo.insert(baseEvent);

      const labelsParam = mock.queries[0].params[7];
      expect(typeof labelsParam).toBe('string');
      expect(JSON.parse(labelsParam as string)).toEqual(baseEvent.labels);
    });
  });

  describe('getCurrentSnapshot', () => {
    it('issues DISTINCT ON query and returns mapped rows', async () => {
      mock.pushResult([dbRow, { ...dbRow, container_id: 'def456', name: 'sonarr', host: 'remotehost' }]);

      const rows = await repo.getCurrentSnapshot();

      expect(mock.queries[0].sql).toContain('DISTINCT ON (host, container_id)');
      expect(mock.queries[0].sql).toContain('ORDER BY host, container_id, at DESC');
      expect(mock.queries[0].params).toEqual([]);
      expect(rows).toHaveLength(2);
      expect(rows[0].containerId).toBe('abc123');
      expect(rows[1].containerId).toBe('def456');
    });

    it('returns one row per (host, container_id)', async () => {
      mock.pushResult([
        { ...dbRow, host: 'host-a', container_id: 'c1' },
        { ...dbRow, host: 'host-a', container_id: 'c2' },
        { ...dbRow, host: 'host-b', container_id: 'c1' },
      ]);

      const rows = await repo.getCurrentSnapshot();
      expect(rows).toHaveLength(3);
    });

    it('returns empty array when no events exist', async () => {
      mock.pushResult([]);
      const rows = await repo.getCurrentSnapshot();
      expect(rows).toEqual([]);
    });
  });

  describe('getLatestForContainer', () => {
    it('queries by host and container_id with LIMIT 1 ordered by at DESC', async () => {
      mock.pushResult([dbRow]);

      const row = await repo.getLatestForContainer('homeserver', 'abc123');

      expect(mock.queries[0].sql).toContain('WHERE host = $1 AND container_id = $2');
      expect(mock.queries[0].sql).toContain('ORDER BY at DESC');
      expect(mock.queries[0].sql).toContain('LIMIT 1');
      expect(mock.queries[0].params).toEqual(['homeserver', 'abc123']);
      expect(row).not.toBeNull();
      expect(row!.containerId).toBe('abc123');
      expect(row!.state).toBe('running');
    });

    it('returns null when no rows match', async () => {
      mock.pushResult([]);
      const row = await repo.getLatestForContainer('homeserver', 'notfound');
      expect(row).toBeNull();
    });

    it('maps compose_project from stored column', async () => {
      mock.pushResult([{ ...dbRow, compose_project: 'media' }]);
      const row = await repo.getLatestForContainer('homeserver', 'abc123');
      expect(row!.composeProject).toBe('media');
    });
  });

  describe('getHistoryForContainer', () => {
    it('queries with since filter ordered by at ASC', async () => {
      const since = new Date('2026-04-16T00:00:00Z');
      const row2 = { ...dbRow, at: new Date('2026-04-16T11:00:00Z'), state: 'exited' };
      mock.pushResult([dbRow, row2]);

      const rows = await repo.getHistoryForContainer('homeserver', 'abc123', since);

      expect(mock.queries[0].sql).toContain('WHERE host = $1 AND container_id = $2 AND at >= $3');
      expect(mock.queries[0].sql).toContain('ORDER BY at ASC');
      expect(mock.queries[0].params).toEqual(['homeserver', 'abc123', since]);
      expect(rows).toHaveLength(2);
      expect(rows[0].state).toBe('running');
      expect(rows[1].state).toBe('exited');
    });

    it('returns empty array when no history exists', async () => {
      mock.pushResult([]);
      const rows = await repo.getHistoryForContainer('homeserver', 'abc123', new Date());
      expect(rows).toEqual([]);
    });

    it('returns events in chronological order (oldest first)', async () => {
      const t1 = new Date('2026-04-16T10:00:00Z');
      const t2 = new Date('2026-04-16T11:00:00Z');
      mock.pushResult([
        { ...dbRow, at: t1, state: 'running' },
        { ...dbRow, at: t2, state: 'exited' },
      ]);

      const rows = await repo.getHistoryForContainer('homeserver', 'abc123', t1);
      expect(rows[0].at).toEqual(t1);
      expect(rows[1].at).toEqual(t2);
    });
  });

  describe('row mapping', () => {
    it('maps null nullable fields correctly', async () => {
      const rowWithNulls = {
        ...dbRow,
        state: null,
        name: null,
        image: null,
        compose_project: null,
        service_key: null,
        started_at: null,
        finished_at: null,
        exit_code: null,
      };
      mock.pushResult([rowWithNulls]);

      const row = await repo.getLatestForContainer('homeserver', 'abc123');
      expect(row!.state).toBeNull();
      expect(row!.name).toBeNull();
      expect(row!.image).toBeNull();
      expect(row!.composeProject).toBeNull();
      expect(row!.serviceKey).toBeNull();
      expect(row!.startedAt).toBeNull();
      expect(row!.finishedAt).toBeNull();
      expect(row!.exitCode).toBeNull();
    });

    it('preserves exitCode integer', async () => {
      mock.pushResult([{ ...dbRow, state: 'exited', exit_code: 1, finished_at: new Date() }]);
      const row = await repo.getLatestForContainer('homeserver', 'abc123');
      expect(row!.exitCode).toBe(1);
    });
  });
});
