import { describe, expect, it, beforeEach, afterEach, spyOn } from 'bun:test';
import { mockModule } from '@/lib/test/mock-module';
import { mockSetTimeout, type TimerMock } from '@/lib/test/mock-timers';
import { waitForCondition } from '@/lib/test/wait-for-condition';
import type { DockerContainerEventUpsertRow } from '@/lib/database/repositories/docker-container-event-repository';
import type { ImageUpdateCheckRepository, ImageUpdateCheckRow } from '@/lib/database/repositories/image-update-check-repository';
import type { ImageUpdateSummary } from '@/types/image-updates';

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

interface CheckResult {
  summary: ImageUpdateSummary;
  etag: string | null;
}

const registryState: { results: Map<string, CheckResult>; calls: string[] } = { results: new Map(), calls: [] };

mockModule<typeof import('@/lib/image-updates/registry-client')>('@/lib/image-updates/registry-client', (real) => ({
  ...real,
  checkImageUpdateWithMeta: async (image: string, _labels: Record<string, string>, _digest: string | null, storedEtag: string | null) => {
    registryState.calls.push(image + '|' + (storedEtag ?? ''));
    const result = registryState.results.get(image);
    if (result) return result;
    return {
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

interface UpsertSuccessCall {
  host: string;
  image: string;
  updateAvailable: boolean | null;
  latestMatchingTag: string | null;
  etag: string | null;
  checkedAt: Date;
}

function createRepoMock(initialRows: ImageUpdateCheckRow[]) {
  let rows = initialRows;
  const upserts: UpsertSuccessCall[] = [];
  const failures: Array<{ host: string; image: string; error: string }> = [];
  const repo = {
    getAll: async () => rows,
    getByHost: async (host: string) => rows.filter((r) => r.host === host),
    upsertSuccess: async (check: UpsertSuccessCall) => {
      upserts.push(check);
      rows = rows.filter((r) => !(r.host === check.host && r.image === check.image));
      rows.push({ ...check, error: null, lastErrorAt: null, checkedAt: check.checkedAt } as ImageUpdateCheckRow);
    },
    upsertFailure: async (host: string, image: string, error: string) => {
      failures.push({ host, image, error });
    },
    deleteMissing: async () => {},
    isRefreshDue: async () => rows.length === 0,
  };
  return { repo: repo as unknown as ImageUpdateCheckRepository, upserts, failures };
}

let containerRows: DockerContainerEventUpsertRow[] = [];
let repoMock: ReturnType<typeof createRepoMock>;
let summaryCacheCleared = 0;
let stackLoaderOverride: (() => Promise<DockerContainerEventUpsertRow[]>) | null = null;

mockModule<typeof import('@/lib/image-updates/image-update-service')>('@/lib/image-updates/image-update-service', (real) => ({
  ...real,
  loadStackContainers: async () => {
    if (stackLoaderOverride) return stackLoaderOverride();
    return containerRows;
  },
  loadCheckRepository: async () => repoMock.repo,
  clearImageUpdateSummaryCache: () => {
    summaryCacheCleared += 1;
  },
}));

async function buildManualCheck() {
  const { runManualImageUpdateCheck } = await import('../manual-check');
  return runManualImageUpdateCheck;
}

describe('runManualImageUpdateCheck', () => {
  beforeEach(() => {
    registryState.calls = [];
    registryState.results = new Map();
    publishLog.length = 0;
    summaryCacheCleared = 0;
    containerRows = [];
    repoMock = createRepoMock([]);
  });

  it('checks every image of the stack once and returns sorted summaries', async () => {
    containerRows = [
      containerRow({ image: 'redis:7' }),
      containerRow({ image: 'app:1', containerId: 'def456', name: 'web' }),
      containerRow({ image: 'redis:7', containerId: 'ghi789', name: 'cache' }),
    ];
    const run = await buildManualCheck();
    const result = await run('web', 'host1');

    expect(registryState.calls).toHaveLength(2);
    expect(result.checked).toBe(2);
    expect(result.failed).toBe(0);
    expect(result.changed).toBe(0);
    expect(result.summaries.map((s) => s.image)).toEqual(['app:1', 'redis:7']);
    expect(result.summaries.every((s) => typeof s.checkedAt === 'string')).toBe(true);
    expect(summaryCacheCleared).toBe(1);
  });

  it('scopes the check to one image when an image is given', async () => {
    containerRows = [
      containerRow({ image: 'redis:7' }),
      containerRow({ image: 'app:1', containerId: 'def456', name: 'web' }),
    ];
    const run = await buildManualCheck();
    const result = await run('web', 'host1', 'app:1');

    expect(registryState.calls).toEqual(['app:1|']);
    expect(result.checked).toBe(1);
    expect(result.summaries).toHaveLength(1);
    expect(result.summaries[0].image).toBe('app:1');
  });

  it('does nothing and reports zero checks when the stack has no containers', async () => {
    const run = await buildManualCheck();
    const result = await run('web', 'host1');

    expect(registryState.calls).toHaveLength(0);
    expect(result.checked).toBe(0);
    expect(result.summaries).toEqual([]);
    expect(summaryCacheCleared).toBe(1);
  });

  it('concurrent stack checks join the in-flight run instead of stacking work', async () => {
    containerRows = [
      containerRow({ image: 'redis:7' }),
      containerRow({ image: 'app:1', containerId: 'def456', name: 'web' }),
    ];
    const run = await buildManualCheck();
    const [first, second] = await Promise.all([run('web', 'host1'), run('web', 'host1')]);

    expect(registryState.calls).toHaveLength(2);
    expect(first).toBe(second);
  });

  it('concurrent checks with different image scopes run independently', async () => {
    containerRows = [
      containerRow({ image: 'redis:7' }),
      containerRow({ image: 'app:1', containerId: 'def456', name: 'web' }),
    ];
    const run = await buildManualCheck();
    await Promise.all([run('web', 'host1', 'redis:7'), run('web', 'host1', 'app:1')]);

    expect(registryState.calls).toHaveLength(2);
  });

  it('publishes a changed event when the verdict flips against the prior row', async () => {
    containerRows = [containerRow({ image: 'redis:7' })];
    repoMock = createRepoMock([checkRow({ updateAvailable: false, latestMatchingTag: null })]);
    registryState.results.set('redis:7', {
      summary: { image: 'redis:7', currentTag: '7', latestMatchingTag: '7.4.2', latestOverallTag: null, updateAvailable: true, sourceRepo: null, error: null },
      etag: null,
    });
    const run = await buildManualCheck();
    const result = await run('web', 'host1');

    expect(result.changed).toBe(1);
    expect(publishLog).toHaveLength(1);
    expect(publishLog[0]).toEqual([
      { stack: 'web', host: 'host1', image: 'redis:7', updateAvailable: true, latestMatchingTag: '7.4.2' },
    ]);
  });

  it('does not publish when the verdict is unchanged', async () => {
    containerRows = [containerRow({ image: 'redis:7' })];
    repoMock = createRepoMock([checkRow({ updateAvailable: false, latestMatchingTag: null })]);
    const run = await buildManualCheck();
    const result = await run('web', 'host1');

    expect(result.changed).toBe(0);
    expect(publishLog).toHaveLength(0);
  });

  it('counts a registry error summary as failed, persists it, and publishes nothing', async () => {
    containerRows = [containerRow({ image: 'redis:7' })];
    registryState.results.set('redis:7', {
      summary: { image: 'redis:7', currentTag: '7', latestMatchingTag: null, latestOverallTag: null, updateAvailable: null, sourceRepo: null, error: 'registry down' },
      etag: null,
    });
    const run = await buildManualCheck();
    const result = await run('web', 'host1');

    expect(result.failed).toBe(1);
    expect(result.checked).toBe(0);
    expect(repoMock.failures).toEqual([{ host: 'host1', image: 'redis:7', error: 'registry down' }]);
    expect(publishLog).toHaveLength(0);
  });

  it('records a thrown registry error as a failure with the thrown message', async () => {
    containerRows = [containerRow({ image: 'redis:7' })];
    registryState.results.set('redis:7', {
      get summary(): ImageUpdateSummary {
        throw new Error('tag list exploded');
      },
      etag: null,
    });
    const run = await buildManualCheck();
    const result = await run('web', 'host1');

    expect(result.failed).toBe(1);
    expect(repoMock.failures[0].error).toBe('tag list exploded');
    expect(result.summaries[0].error).toBe('tag list exploded');
  });
});

describe('schedulePostUpdateCheck', () => {
  let timers: TimerMock;
  const realNow = Date.now;

  beforeEach(() => {
    registryState.calls = [];
    registryState.results = new Map();
    publishLog.length = 0;
    summaryCacheCleared = 0;
    containerRows = [];
    repoMock = createRepoMock([]);
    Date.now = () => Date.parse('2026-01-03T00:00:00Z');
    timers = mockSetTimeout();
  });

  afterEach(() => {
    Date.now = realNow;
    timers.restore();
  });

  it('runs a stack-wide check after the delay', async () => {
    containerRows = [containerRow({ image: 'redis:7' })];
    const { schedulePostUpdateCheck } = await import('../manual-check');
    schedulePostUpdateCheck('web', 'host1', 5_000);

    expect(timers.delays).toEqual([5_000]);
    expect(registryState.calls).toHaveLength(0);
    timers.fire(timers.scheduled[0]);
    timers.restore();
    await waitForCondition(() => registryState.calls.length === 1);
    expect(registryState.calls).toEqual(['redis:7|']);
  });

  it('uses the default 5s delay when none is given', async () => {
    const { schedulePostUpdateCheck } = await import('../manual-check');
    schedulePostUpdateCheck('web', 'host1');
    expect(timers.delays).toEqual([5_000]);
  });

  it('logs and swallows a rejected post-update check', async () => {
    const { schedulePostUpdateCheck } = await import('../manual-check');
    stackLoaderOverride = async () => {
      throw new Error('snapshot gone');
    };
    const errSpy = spyOn(console, 'error').mockImplementation(() => {});

    schedulePostUpdateCheck('web', 'host1', 1_000);
    timers.fire(timers.scheduled[0]);
    timers.restore();
    await waitForCondition(() => errSpy.mock.calls.some((call) => String(call[0]).includes('post-update check failed')));

    expect(errSpy.mock.calls.some((call) => String(call[0]).includes('post-update check failed'))).toBe(true);
    errSpy.mockRestore();
    stackLoaderOverride = null;
  });
});
