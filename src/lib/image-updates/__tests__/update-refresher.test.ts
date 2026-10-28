import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { mockModule } from '@/lib/test/mock-module';
import { mockSetTimeout, type TimerMock } from '@/lib/test/mock-timers';
import { waitForCondition } from '@/lib/test/wait-for-condition';
import type { DockerContainerEventUpsertRow } from '@/lib/database/repositories/docker-container-event-repository';
import type { ImageUpdateCheckRepository, ImageUpdateCheckRow } from '@/lib/database/repositories/image-update-check-repository';

function containerRow(overrides: Partial<DockerContainerEventUpsertRow> = {}): DockerContainerEventUpsertRow {
  return {
    at: new Date('2026-01-01T00:00:00Z'),
    host: 'host1',
    containerId: 'abc123',
    eventType: 'upsert',
    state: 'running',
    name: 'app',
    image: 'redis:7',
    imageDigest: null,
    labels: {},
    ports: [],
    mounts: [],
    composeProject: 'web',
    serviceKey: 'web-app',
    startedAt: null,
    finishedAt: null,
    exitCode: null,
    ...overrides,
  };
}

function checkRow(overrides: Partial<ImageUpdateCheckRow> = {}): ImageUpdateCheckRow {
  return {
    host: 'host1',
    image: 'redis:7',
    currentTag: '7',
    latestMatchingTag: null,
    latestOverallTag: null,
    updateAvailable: false,
    sourceRepo: null,
    error: null,
    lastErrorAt: null,
    etag: null,
    checkedAt: new Date('2026-01-02T00:00:00Z'),
    ...overrides,
  };
}

interface UpsertSuccessCall {
  host: string;
  image: string;
  updateAvailable: boolean | null;
  latestMatchingTag: string | null;
  etag: string | null;
  checkedAt: Date;
}

interface CheckResult {
  summary: {
    image: string;
    currentTag: string | null;
    latestMatchingTag: string | null;
    latestOverallTag: string | null;
    updateAvailable: boolean | null;
    sourceRepo: string | null;
    error: string | null;
  };
  etag: string | null;
}

const registryState: { results: Map<string, CheckResult>; calls: string[] } = { results: new Map(), calls: [] };

mockModule<typeof import('@/lib/image-updates/registry-client')>('@/lib/image-updates/registry-client', (real) => ({
  ...real,
  checkImageUpdateWithMeta: async (image: string, _labels: Record<string, string>, _digest: string | null, storedEtag: string | null) => {
    registryState.calls.push(image + '|' + (storedEtag ?? ''));
    return registryState.results.get(image) ?? {
      summary: { image, currentTag: '7', latestMatchingTag: null, latestOverallTag: null, updateAvailable: false, sourceRepo: null, error: null },
      etag: null,
    };
  },
}));

const publishLog: unknown[][] = [];

mockModule<typeof import('@/lib/stacks/image-update-broadcast-service')>(
  '@/lib/stacks/image-update-broadcast-service',
  (real) => ({
    ...real,
    imageUpdateBroadcastService: {
      publish: (events: unknown[]) => {
        publishLog.push(events);
      },
      subscribe: () => () => {},
    },
  }),
);

function createRepoMock(initialRows: ImageUpdateCheckRow[]) {
  let rows = initialRows;
  const upserts: UpsertSuccessCall[] = [];
  const failures: Array<{ host: string; image: string; error: string }> = [];
  const deletions: Array<Array<{ host: string; image: string }>> = [];
  const repo = {
    getAll: async () => rows,
    getByHost: async () => rows,
    upsertSuccess: async (check: UpsertSuccessCall) => {
      upserts.push(check);
      rows = rows.filter((r) => !(r.host === check.host && r.image === check.image));
      rows.push({ ...check, error: null, lastErrorAt: null, checkedAt: check.checkedAt } as ImageUpdateCheckRow);
    },
    upsertFailure: async (host: string, image: string, error: string) => {
      failures.push({ host, image, error });
    },
    deleteMissing: async (keep: Array<{ host: string; image: string }>) => {
      deletions.push(keep);
    },
    isRefreshDue: async () => rows.length === 0,
  };
  return { repo: repo as unknown as ImageUpdateCheckRepository, upserts, failures, deletions };
}

const HOUR = 3_600_000;
const INTERVAL = 12 * HOUR;

async function buildRefresher(rows: ImageUpdateCheckRow[], containers: DockerContainerEventUpsertRow[], intervalMs = INTERVAL) {
  const { ImageUpdateRefresher } = await import('../update-refresher');
  const repoMock = createRepoMock(rows);
  const refresher = new ImageUpdateRefresher({
    repo: repoMock.repo,
    loadContainers: async () => containers,
    intervalMs,
  });
  return { refresher, ...repoMock };
}

describe('ImageUpdateRefresher', () => {
  let timers: TimerMock;
  const realNow = Date.now;
  let clock = 0;

  beforeEach(() => {
    registryState.calls = [];
    registryState.results = new Map();
    publishLog.length = 0;
    clock = Date.parse('2026-01-03T00:00:00Z');
    Date.now = () => clock;
    timers = mockSetTimeout();
  });

  afterEach(() => {
    Date.now = realNow;
    timers.restore();
  });

  it('start with stale rows runs a catch-up tick immediately and schedules the next at the interval', async () => {
    registryState.results.set('redis:7', {
      summary: { image: 'redis:7', currentTag: '7', latestMatchingTag: '7.4.2', latestOverallTag: null, updateAvailable: true, sourceRepo: null, error: null },
      etag: '"etag-1"',
    });
    const { refresher, upserts } = await buildRefresher(
      [checkRow({ checkedAt: new Date(clock - 13 * HOUR) })],
      [containerRow()],
    );
    await refresher.start();

    expect(upserts).toHaveLength(1);
    expect(upserts[0].latestMatchingTag).toBe('7.4.2');
    expect(upserts[0].etag).toBe('"etag-1"');
    expect(timers.delays).toEqual([INTERVAL]);
  });

  it('start with fresh rows schedules from the newest checked_at and does not tick', async () => {
    const { refresher, upserts } = await buildRefresher(
      [checkRow({ checkedAt: new Date(clock - 5 * HOUR) }), checkRow({ image: 'app:1', checkedAt: new Date(clock - 2 * HOUR) })],
      [containerRow()],
    );
    await refresher.start();

    expect(upserts).toHaveLength(0);
    expect(registryState.calls).toHaveLength(0);
    expect(timers.delays).toEqual([10 * HOUR]);
  });

  it('start with no rows at all ticks immediately (fresh install)', async () => {
    const { refresher, upserts } = await buildRefresher([], [containerRow()]);
    await refresher.start();
    expect(upserts).toHaveLength(1);
    expect(timers.delays).toEqual([INTERVAL]);
  });

  it('a fired timer runs the next tick and reschedules', async () => {
    registryState.results.set('redis:7', {
      summary: { image: 'redis:7', currentTag: '7', latestMatchingTag: null, latestOverallTag: null, updateAvailable: false, sourceRepo: null, error: null },
      etag: null,
    });
    const { refresher, upserts } = await buildRefresher(
      [checkRow({ checkedAt: new Date(clock - 13 * HOUR) })],
      [containerRow()],
    );
    await refresher.start();
    expect(upserts).toHaveLength(1);

    timers.fire(timers.scheduled[0]);
    timers.restore();
    await waitForCondition(() => upserts.length === 2);
    refresher.stop();
  });

  it('start is idempotent and stop cancels the pending timer', async () => {
    const { refresher } = await buildRefresher([], []);
    await refresher.start();
    await refresher.start();
    expect(timers.scheduled).toHaveLength(1);

    refresher.stop();
    expect(timers.pending).toHaveLength(0);
  });

  it('tick checks each distinct (host, image) once and sweeps rows missing from the snapshot', async () => {
    registryState.results.set('redis:7', {
      summary: { image: 'redis:7', currentTag: '7', latestMatchingTag: null, latestOverallTag: null, updateAvailable: false, sourceRepo: null, error: null },
      etag: '"e1"',
    });
    const { refresher, upserts, deletions } = await buildRefresher(
      [checkRow(), checkRow({ host: 'host2', image: 'ghost:1' })],
      [
        containerRow({ containerId: 'a' }),
        containerRow({ containerId: 'b' }),
        containerRow({ host: 'host2', image: 'traefik:v3.1', composeProject: 'edge' }),
      ],
    );
    const result = await refresher.tick();

    expect(result).toEqual({ checked: 2, changed: 0, failed: 0 });
    expect(registryState.calls).toEqual(['redis:7|', 'traefik:v3.1|']);
    expect(upserts).toHaveLength(2);
    expect(deletions).toEqual([
      [
        { host: 'host1', image: 'redis:7' },
        { host: 'host2', image: 'traefik:v3.1' },
      ],
    ]);
  });

  it('tick sends the stored etag on the next check', async () => {
    const { refresher } = await buildRefresher(
      [checkRow({ image: 'myapp:latest', etag: '"stored-etag"' })],
      [containerRow({ image: 'myapp:latest', imageDigest: 'sha256:' + 'a'.repeat(64) })],
    );
    await refresher.tick();
    expect(registryState.calls).toEqual(['myapp:latest|"stored-etag"']);
  });

  it('tick publishes a change event when the update state moves', async () => {
    registryState.results.set('redis:7', {
      summary: { image: 'redis:7', currentTag: '7', latestMatchingTag: '7.4.2', latestOverallTag: null, updateAvailable: true, sourceRepo: null, error: null },
      etag: null,
    });
    const { refresher } = await buildRefresher([checkRow({ updateAvailable: false, latestMatchingTag: null })], [containerRow()]);
    const result = await refresher.tick();

    expect(result).toEqual({ checked: 1, changed: 1, failed: 0 });
    expect(publishLog).toHaveLength(1);
    expect(publishLog[0]).toEqual([
      { stack: 'web', host: 'host1', image: 'redis:7', updateAvailable: true, latestMatchingTag: '7.4.2' },
    ]);
  });

  it('tick does not publish for a first-ever row', async () => {
    registryState.results.set('redis:7', {
      summary: { image: 'redis:7', currentTag: '7', latestMatchingTag: '7.4.2', latestOverallTag: null, updateAvailable: true, sourceRepo: null, error: null },
      etag: null,
    });
    const { refresher } = await buildRefresher([], [containerRow()]);
    await refresher.tick();
    expect(publishLog).toHaveLength(0);
  });

  it('a failed check records the error and keeps the prior tags', async () => {
    registryState.results.set('redis:7', {
      summary: { image: 'redis:7', currentTag: '7', latestMatchingTag: null, latestOverallTag: null, updateAvailable: null, sourceRepo: null, error: 'Docker Hub returned 503 for library/redis' },
      etag: null,
    });
    const { refresher, upserts, failures } = await buildRefresher([checkRow()], [containerRow()]);
    const result = await refresher.tick();

    expect(result).toEqual({ checked: 0, changed: 0, failed: 1 });
    expect(upserts).toHaveLength(0);
    expect(failures).toHaveLength(1);
    expect(failures[0].error).toBe('Docker Hub returned 503 for library/redis');
    expect(publishLog).toHaveLength(0);
  });

  it('a concurrent tick on the same refresher returns null instead of stacking work', async () => {
    const { ImageUpdateRefresher } = await import('../update-refresher');
    const repoMock = createRepoMock([]);
    let releaseLoad: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseLoad = resolve;
    });
    const slow = new ImageUpdateRefresher({
      repo: repoMock.repo,
      loadContainers: async () => {
        await gate;
        return [containerRow()];
      },
      intervalMs: INTERVAL,
    });

    const first = slow.tick();
    const second = await slow.tick();
    expect(second).toBeNull();

    releaseLoad();
    expect(await first).toEqual({ checked: 1, changed: 0, failed: 0 });
  });
});
