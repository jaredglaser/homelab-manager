import { describe, expect, it, beforeEach, afterEach, spyOn } from 'bun:test';
import { mockModule } from '@/lib/test/mock-module';
import { mockSetTimeout, type TimerMock } from '@/lib/test/mock-timers';
import type { DockerInventoryBroadcastEvent } from '@/types/docker-inventory';
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
    stack: 'web',
    image: 'redis:7',
    manifestDigest: null,
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
  stack: string;
  image: string;
  updateAvailable: boolean | null;
  latestMatchingTag: string | null;
  etag: string | null;
  manifestDigest: string | null;
  checkedAt: Date;
}

function createRepoMock(initialRows: ImageUpdateCheckRow[]) {
  let rows = initialRows;
  const upserts: UpsertSuccessCall[] = [];
  const failures: Array<{ host: string; stack: string; image: string; error: string }> = [];
  const repo = {
    getAll: async () => rows,
    getByStack: async (host: string, stack: string) => rows.filter((r) => r.host === host && r.stack === stack),
    upsertSuccess: async (check: UpsertSuccessCall) => {
      upserts.push(check);
      rows = rows.filter((r) => !(r.host === check.host && r.stack === check.stack && r.image === check.image));
      rows.push({ ...check, error: null, lastErrorAt: null, checkedAt: check.checkedAt } as ImageUpdateCheckRow);
    },
    upsertFailure: async (host: string, stack: string, image: string, error: string) => {
      failures.push({ host, stack, image, error });
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

  it('a different-image caller chains after the in-flight run instead of joining it', async () => {
    containerRows = [
      containerRow({ image: 'redis:7' }),
      containerRow({ image: 'app:1', containerId: 'def456', name: 'web' }),
    ];
    const run = await buildManualCheck();
    await Promise.all([run('web', 'host1', 'redis:7'), run('web', 'host1', 'app:1')]);

    expect(registryState.calls).toHaveLength(2);
  });

  it('a single-image caller joining a stack-wide run gets scoped results', async () => {
    let releaseSnapshot: (() => void) | null = null;
    containerRows = [
      containerRow({ image: 'redis:7' }),
      containerRow({ image: 'app:1', containerId: 'def456', name: 'web' }),
    ];
    stackLoaderOverride = () => new Promise((resolve) => {
      releaseSnapshot = () => resolve(containerRows);
    });
    const getRelease = () => releaseSnapshot;
    const run = await buildManualCheck();
    const stackWide = run('web', 'host1');
    const single = run('web', 'host1', 'redis:7');
    getRelease()?.();
    const [wideResult, singleResult] = await Promise.all([stackWide, single]);
    stackLoaderOverride = null;

    expect(wideResult.summaries).toHaveLength(2);
    expect(singleResult.summaries.map((summary) => summary.image)).toEqual(['redis:7']);
    expect(singleResult.checked).toBe(1);
    expect(singleResult.failed).toBe(0);
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
    expect(repoMock.failures).toEqual([{ host: 'host1', stack: 'web', image: 'redis:7', error: 'registry down' }]);
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

describe('PostUpdateWatcher', () => {
  let timers: TimerMock;
  let nowMs: number;
  let eventHandler: ((event: DockerInventoryBroadcastEvent) => void) | null = null;
  const invalidated: Array<[string, string]> = [];
  const realNow = Date.now;

  beforeEach(() => {
    registryState.calls = [];
    registryState.results = new Map();
    publishLog.length = 0;
    summaryCacheCleared = 0;
    containerRows = [];
    repoMock = createRepoMock([]);
    nowMs = Date.parse('2026-01-03T00:00:00Z');
    Date.now = () => nowMs;
    eventHandler = null;
    invalidated.length = 0;
    timers = mockSetTimeout();
  });

  afterEach(() => {
    Date.now = realNow;
    timers.restore();
  });

  async function buildWatcher() {
    const { PostUpdateWatcher } = await import('../post-update-watcher');
    return new PostUpdateWatcher({
      loadSnapshot: async () => {
        if (stackLoaderOverride) return stackLoaderOverride();
        return containerRows;
      },
      runCheck: async (stack: string, host: string) => {
        const { runManualImageUpdateCheck } = await import('../manual-check');
        return runManualImageUpdateCheck(stack, host);
      },
      subscribe: (callback: (event: DockerInventoryBroadcastEvent) => void) => {
        eventHandler = callback;
        return () => {};
      },
      invalidate: (host: string, stack: string) => {
        invalidated.push([host, stack]);
      },
      now: () => nowMs,
    });
  }

  function notifyUpsert(): void {
    eventHandler?.({
      type: 'upsert',
      container: {
        host: 'host1',
        containerId: 'abc123',
        name: 'app',
        image: 'redis:7',
        imageDigest: null,
        state: 'running' as const,
        composeProject: 'web',
        serviceKey: 'web-app',
        startedAt: null,
        finishedAt: null,
        exitCode: null,
        labels: {},
        ports: [],
        mounts: [],
        updatedAt: new Date(nowMs),
      },
    } as DockerInventoryBroadcastEvent);
  }

  it('runs the check once the snapshot reflects the update', async () => {
    containerRows = [containerRow({ at: new Date(nowMs) })];
    const watcher = await buildWatcher();
    watcher.arm('web', 'host1', nowMs);

    expect(timers.delays).toEqual([5_000]);
    expect(registryState.calls).toHaveLength(0);
    nowMs += 5_000;
    timers.fire(timers.scheduled[0]);
    timers.restore();
    await waitForCondition(() => registryState.calls.length === 1);
    expect(registryState.calls).toEqual(['redis:7|']);
  });

  it('defers while the snapshot is stale and gives up without checking at the deadline', async () => {
    containerRows = [containerRow()];
    const errSpy = spyOn(console, 'error').mockImplementation(() => {});
    const watcher = await buildWatcher();
    watcher.arm('web', 'host1', nowMs);

    nowMs += 5_000;
    timers.fire(timers.scheduled[0]);
    // The next poll is scheduled at the end of the async test; settle the chain
    // without the mock (setImmediate is not captured) before asserting on it.
    await new Promise((resolve) => setImmediate(resolve));
    expect(timers.delays).toContain(10_000);
    expect(registryState.calls).toHaveLength(0);

    nowMs += 3 * 60_000;
    timers.fire(timers.scheduled[1]);
    timers.restore();
    await waitForCondition(() => errSpy.mock.calls.some((call) => String(call[0]).includes('skipping the post-update check')));
    expect(registryState.calls).toHaveLength(0);
    expect(watcher.pending()).toBe(0);
    errSpy.mockRestore();
  });

  it('a NOTIFY upsert triggers an early converged check and invalidates the summary cache', async () => {
    containerRows = [containerRow({ at: new Date(nowMs) })];
    const watcher = await buildWatcher();
    watcher.arm('web', 'host1', nowMs);

    notifyUpsert();
    expect(timers.delays).toContain(2_000);
    const debounce = timers.scheduled[timers.delays.indexOf(2_000)];
    nowMs += 2_000;
    timers.fire(debounce);
    timers.restore();
    await waitForCondition(() => registryState.calls.length === 1);
    expect(invalidated).toContainEqual(['host1', 'web']);
  });

  it('a scheduled check chains after a pre-update in-flight run instead of joining it', async () => {
    let releaseSnapshot: (() => void) | null = null;
    containerRows = [containerRow()];
    stackLoaderOverride = () => new Promise((resolve) => {
      releaseSnapshot = () => resolve(containerRows);
    });
    const getRelease = () => releaseSnapshot;
    const watcher = await buildWatcher();
    const { runManualImageUpdateCheck } = await import('../manual-check');
    const first = runManualImageUpdateCheck('web', 'host1');
    watcher.arm('web', 'host1', nowMs);

    containerRows = [containerRow({ at: new Date(nowMs) })];
    stackLoaderOverride = null;
    nowMs += 5_000;
    timers.fire(timers.scheduled[0]);
    // The watcher converged and chained behind the pre-update run; releasing
    // the snapshot lets that run finish so the fresh one can start.
    await new Promise((resolve) => setImmediate(resolve));
    getRelease()?.();
    timers.restore();
    await waitForCondition(() => registryState.calls.length === 2);
    await first;
    expect(registryState.calls).toEqual(['redis:7|', 'redis:7|']);
  });

  it('re-arming replaces the waiter and runs the check once', async () => {
    containerRows = [containerRow({ at: new Date(nowMs) })];
    const watcher = await buildWatcher();
    watcher.arm('web', 'host1', nowMs - 60_000);
    watcher.arm('web', 'host1', nowMs);
    expect(watcher.pending()).toBe(1);

    nowMs += 5_000;
    timers.fire(timers.scheduled[0]);
    timers.restore();
    await waitForCondition(() => registryState.calls.length === 1);
    expect(registryState.calls).toEqual(['redis:7|']);
  });
});
