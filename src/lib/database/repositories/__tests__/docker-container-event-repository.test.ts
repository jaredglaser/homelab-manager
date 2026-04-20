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
      if (result.eventType !== 'upsert') throw new Error('expected upsert row');
      expect(result.state).toBe('running');
      expect(result.composeProject).toBe('media');
      expect(result.serviceKey).toBe('media/plex');
      expect(result.startedAt).toEqual(new Date('2026-04-16T09:50:00Z'));
      expect(result.finishedAt).toBeNull();
      expect(result.exitCode).toBeNull();
    });

    it('inserts a destroy event with null fields', async () => {
      const destroyEvent: NewContainerEvent = {
        at: new Date(),
        host: 'homeserver',
        containerId: 'abc123',
        eventType: 'destroy',
      };
      mock.pushResult([{ ...dbRow, event_type: 'destroy', state: null, name: null, image: null, labels: {}, compose_project: null, service_key: null, started_at: null }]);

      const result = await repo.insert(destroyEvent);

      expect(result.eventType).toBe('destroy');
      // Destroy variant omits state/composeProject (enforced by the SQL CHECK constraint
      // and the discriminated union type).
      expect(Object.keys(result)).not.toContain('state');
      expect(Object.keys(result)).not.toContain('composeProject');
    });

    it('destroy event sends null for all optional fields in the SQL params', async () => {
      const destroyEvent: NewContainerEvent = {
        at: new Date('2026-04-16T10:00:00Z'),
        host: 'homeserver',
        containerId: 'abc123',
        eventType: 'destroy',
      };
      mock.pushResult([{ ...dbRow, event_type: 'destroy', state: null, name: null, image: null, labels: {}, compose_project: null, service_key: null, started_at: null }]);

      await repo.insert(destroyEvent);

      const params = mock.queries[0].params;
      expect(params[4]).toBeNull();  // state
      expect(params[5]).toBeNull();  // name
      expect(params[6]).toBeNull();  // image
      expect(params[8]).toBeNull();  // service_key
      expect(params[9]).toBeNull();  // started_at
      expect(params[10]).toBeNull(); // finished_at
      expect(params[11]).toBeNull(); // exit_code
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

    it('returns destroy row when it is the latest event for a container (caller filters)', async () => {
      const latestDestroy = {
        ...dbRow,
        at: new Date('2026-04-16T10:05:00Z'),
        event_type: 'destroy',
        state: null,
        name: null,
        image: null,
        labels: {},
        compose_project: null,
        service_key: null,
        started_at: null,
      };
      mock.pushResult([latestDestroy]);

      const rows = await repo.getCurrentSnapshot();
      expect(rows).toHaveLength(1);
      expect(rows[0].eventType).toBe('destroy');
      expect(rows[0].containerId).toBe('abc123');
    });
  });

  describe('row mapping', () => {
    it('maps null nullable fields correctly (upsert row with nullable metadata)', async () => {
      const rowWithNulls = {
        ...dbRow,
        compose_project: null,
        service_key: null,
        started_at: null,
        finished_at: null,
        exit_code: null,
      };
      mock.pushResult([rowWithNulls]);

      const result = await repo.insert(baseEvent);
      // Re-push for getCurrentSnapshot to use
      mock.pushResult([rowWithNulls]);
      const rows = await repo.getCurrentSnapshot();
      const row = rows[0];
      if (row.eventType !== 'upsert') throw new Error('expected upsert row');
      expect(row.composeProject).toBeNull();
      expect(row.serviceKey).toBeNull();
      expect(row.startedAt).toBeNull();
      expect(row.finishedAt).toBeNull();
      expect(row.exitCode).toBeNull();
      void result;
    });

    it('preserves exitCode integer', async () => {
      mock.pushResult([{ ...dbRow, state: 'exited', exit_code: 1, finished_at: new Date() }]);
      const rows = await repo.getCurrentSnapshot();
      const row = rows[0];
      if (row.eventType !== 'upsert') throw new Error('expected upsert row');
      expect(row.exitCode).toBe(1);
    });
  });
});
