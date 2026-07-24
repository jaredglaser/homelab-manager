import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';
import { DeployWatchdog, loadDeployWatchdogConfig, type WatchdogRepo } from '../deploy-watchdog';

interface IntervalHandle {
  cb: () => void;
  ms: number;
  cleared: boolean;
}

function createIntervalHarness() {
  const intervals: IntervalHandle[] = [];
  const setSpy = spyOn(globalThis, 'setInterval').mockImplementation(((cb: () => void, ms: number) => {
    const handle: IntervalHandle = { cb, ms, cleared: false };
    intervals.push(handle);
    return handle as unknown as ReturnType<typeof setInterval>;
  }) as typeof setInterval);
  const clearSpy = spyOn(globalThis, 'clearInterval').mockImplementation(((h: unknown) => {
    const handle = h as IntervalHandle;
    if (handle) handle.cleared = true;
  }) as typeof clearInterval);
  return {
    intervals,
    setSpy,
    clearSpy,
    restore() {
      setSpy.mockRestore();
      clearSpy.mockRestore();
    },
  };
}

function createRepoMock(overrides: Partial<WatchdogRepo> = {}): WatchdogRepo {
  return {
    timeoutStuckDeploys: mock().mockResolvedValue([]) as unknown as WatchdogRepo['timeoutStuckDeploys'],
    notifyStackChange: mock().mockResolvedValue(undefined) as unknown as WatchdogRepo['notifyStackChange'],
    ...overrides,
  };
}

describe('DeployWatchdog', () => {
  let harness: ReturnType<typeof createIntervalHarness>;

  beforeEach(() => {
    harness = createIntervalHarness();
  });

  afterEach(() => {
    harness.restore();
  });

  describe('start / stop', () => {
    it('registers a setInterval with the configured interval', () => {
      const w = new DeployWatchdog({ intervalMs: 500, thresholdMinutes: 10 });
      const repo = createRepoMock();
      w.start(repo);
      expect(harness.intervals).toHaveLength(1);
      expect(harness.intervals[0].ms).toBe(500);
      w.stop();
    });

    it('is a no-op when start is called twice', () => {
      const w = new DeployWatchdog({ intervalMs: 500, thresholdMinutes: 10 });
      const repo = createRepoMock();
      w.start(repo);
      w.start(repo);
      expect(harness.intervals).toHaveLength(1);
      w.stop();
    });

    it('clears the interval on stop', () => {
      const w = new DeployWatchdog({ intervalMs: 500, thresholdMinutes: 10 });
      const repo = createRepoMock();
      w.start(repo);
      w.stop();
      expect(harness.intervals[0].cleared).toBe(true);
    });

    it('is a no-op when stop is called before start', () => {
      const w = new DeployWatchdog({ intervalMs: 500, thresholdMinutes: 10 });
      expect(() => w.stop()).not.toThrow();
      expect(harness.clearSpy).not.toHaveBeenCalled();
    });

    it('can be restarted after stop', () => {
      const w = new DeployWatchdog({ intervalMs: 500, thresholdMinutes: 10 });
      const repo = createRepoMock();
      w.start(repo);
      w.stop();
      w.start(repo);
      expect(harness.intervals).toHaveLength(2);
      w.stop();
    });
  });

  describe('tick', () => {
    it('calls timeoutStuckDeploys with the configured threshold and formatted message', async () => {
      const timeoutStuckDeploys = mock().mockResolvedValue([]);
      const repo = createRepoMock({ timeoutStuckDeploys });
      const w = new DeployWatchdog({ intervalMs: 1000, thresholdMinutes: 45 });

      await w.tick(repo);

      expect(timeoutStuckDeploys).toHaveBeenCalledTimes(1);
      const [threshold, message] = timeoutStuckDeploys.mock.calls[0] as [number, string];
      expect(threshold).toBe(45);
      expect(message).toContain('45 minutes');
      expect(message).toContain('watchdog');
    });

    it('notifies each timed-out row on stack_change with a failed outcome', async () => {
      const rows = [
        { id: 1, stack: 'plex', host: 'homeserver', action: 'deploy', trigger: 'git_push' },
        { id: 2, stack: 'traefik', host: 'homeserver', action: 'teardown', trigger: 'ui' },
      ];
      const timeoutStuckDeploys = mock().mockResolvedValue(rows);
      const notifyStackChange = mock().mockResolvedValue(undefined);
      const repo = createRepoMock({
        timeoutStuckDeploys,
        notifyStackChange,
      } as Partial<WatchdogRepo>);

      const w = new DeployWatchdog({ intervalMs: 1000, thresholdMinutes: 30 });
      await w.tick(repo);

      expect(notifyStackChange).toHaveBeenCalledTimes(2);
      expect(notifyStackChange.mock.calls[0]).toEqual([
        'plex',
        'homeserver',
        { deployId: 1, status: 'failed', action: 'deploy', trigger: 'git_push', message: expect.stringContaining('30 minutes') },
      ]);
      expect(notifyStackChange.mock.calls[1]).toEqual([
        'traefik',
        'homeserver',
        { deployId: 2, status: 'failed', action: 'teardown', trigger: 'ui', message: expect.stringContaining('30 minutes') },
      ]);
    });

    it('does not call notifyStackChange when no deploys are stuck', async () => {
      const notifyStackChange = mock().mockResolvedValue(undefined);
      const repo = createRepoMock({
        timeoutStuckDeploys: mock().mockResolvedValue([]),
        notifyStackChange,
      } as Partial<WatchdogRepo>);

      const w = new DeployWatchdog({ intervalMs: 1000, thresholdMinutes: 30 });
      await w.tick(repo);
      expect(notifyStackChange).not.toHaveBeenCalled();
    });

    it('swallows notify errors so one bad row does not break the sweep', async () => {
      const rows = [
        { id: 1, stack: 'a', host: 'h', action: 'deploy', trigger: 'git_push' },
        { id: 2, stack: 'b', host: 'h', action: 'deploy', trigger: 'git_push' },
      ];
      const notifyStackChange = mock()
        .mockRejectedValueOnce(new Error('notify blew up'))
        .mockResolvedValueOnce(undefined);
      const repo = createRepoMock({
        timeoutStuckDeploys: mock().mockResolvedValue(rows),
        notifyStackChange,
      } as Partial<WatchdogRepo>);
      const errSpy = spyOn(console, 'error').mockImplementation(() => {});

      const w = new DeployWatchdog({ intervalMs: 1000, thresholdMinutes: 30 });
      await expect(w.tick(repo)).resolves.toBeUndefined();
      expect(notifyStackChange).toHaveBeenCalledTimes(2);
      expect(notifyStackChange.mock.calls[0][0]).toBe('a');
      expect(notifyStackChange.mock.calls[0][1]).toBe('h');
      expect(notifyStackChange.mock.calls[1][0]).toBe('b');
      expect(notifyStackChange.mock.calls[1][1]).toBe('h');
      expect(errSpy).toHaveBeenCalled();
      errSpy.mockRestore();
    });

    it('logs and swallows timeoutStuckDeploys errors', async () => {
      const repo = createRepoMock({
        timeoutStuckDeploys: mock().mockRejectedValue(new Error('db is sad')),
      } as Partial<WatchdogRepo>);
      const errSpy = spyOn(console, 'error').mockImplementation(() => {});

      const w = new DeployWatchdog({ intervalMs: 1000, thresholdMinutes: 30 });
      await expect(w.tick(repo)).resolves.toBeUndefined();
      expect(errSpy).toHaveBeenCalled();
      errSpy.mockRestore();
    });

    it('is reentrancy-safe: a second call while a tick is running is ignored', async () => {
      let resolveFirst!: (v: unknown[]) => void;
      const timeoutStuckDeploys = mock().mockImplementation(
        () => new Promise((r) => { resolveFirst = r as (v: unknown[]) => void; }),
      );
      const repo = createRepoMock({
        timeoutStuckDeploys,
      } as Partial<WatchdogRepo>);
      const w = new DeployWatchdog({ intervalMs: 1000, thresholdMinutes: 30 });

      const firstTick = w.tick(repo);
      await w.tick(repo); // should return immediately without calling repo a 2nd time
      expect(timeoutStuckDeploys).toHaveBeenCalledTimes(1);

      resolveFirst([]);
      await firstTick;
    });

    it('releases the reentrancy guard after the first tick completes', async () => {
      const timeoutStuckDeploys = mock().mockResolvedValue([]);
      const repo = createRepoMock({ timeoutStuckDeploys } as Partial<WatchdogRepo>);
      const w = new DeployWatchdog({ intervalMs: 1000, thresholdMinutes: 30 });

      await w.tick(repo);
      await w.tick(repo);
      expect(timeoutStuckDeploys).toHaveBeenCalledTimes(2);
    });

    it('tracks consecutive failures and escalates the log prefix past the threshold', async () => {
      const repo = createRepoMock({
        timeoutStuckDeploys: mock().mockRejectedValue(new Error('db is sad')),
      } as Partial<WatchdogRepo>);
      const errSpy = spyOn(console, 'error').mockImplementation(() => {});

      const w = new DeployWatchdog({ intervalMs: 1000, thresholdMinutes: 30 });
      await w.tick(repo);
      await w.tick(repo);
      expect(w.getConsecutiveFailures()).toBe(2);
      expect(errSpy.mock.calls.at(-1)?.[0]).not.toContain('consecutive failures');

      await w.tick(repo);
      expect(w.getConsecutiveFailures()).toBe(3);
      expect(errSpy.mock.calls.at(-1)?.[0]).toContain('3 consecutive failures');
      expect(errSpy.mock.calls.at(-1)?.[0]).toContain('degraded');

      errSpy.mockRestore();
    });

    it('resets the consecutive failure counter after a successful tick', async () => {
      const timeoutStuckDeploys = mock()
        .mockRejectedValueOnce(new Error('fail'))
        .mockRejectedValueOnce(new Error('fail'))
        .mockResolvedValueOnce([]);
      const repo = createRepoMock({ timeoutStuckDeploys } as Partial<WatchdogRepo>);
      const errSpy = spyOn(console, 'error').mockImplementation(() => {});

      const w = new DeployWatchdog({ intervalMs: 1000, thresholdMinutes: 30 });
      await w.tick(repo);
      await w.tick(repo);
      expect(w.getConsecutiveFailures()).toBe(2);

      await w.tick(repo);
      expect(w.getConsecutiveFailures()).toBe(0);

      errSpy.mockRestore();
    });
  });

  describe('interval firing', () => {
    it('invokes tick when the interval callback runs', async () => {
      const rows = [{ id: 9, stack: 'a', host: 'h', action: 'deploy', trigger: 'git_push' }];
      const timeoutStuckDeploys = mock().mockResolvedValue(rows);
      const notifyStackChange = mock().mockResolvedValue(undefined);
      const repo = createRepoMock({
        timeoutStuckDeploys,
        notifyStackChange,
      } as Partial<WatchdogRepo>);

      const w = new DeployWatchdog({ intervalMs: 100, thresholdMinutes: 5 });
      w.start(repo);
      expect(harness.intervals).toHaveLength(1);

      harness.intervals[0].cb();
      await new Promise((r) => setTimeout(r, 0));

      expect(timeoutStuckDeploys).toHaveBeenCalledTimes(1);
      expect(notifyStackChange).toHaveBeenCalledWith('a', 'h', {
        deployId: 9,
        status: 'failed',
        action: 'deploy',
        trigger: 'git_push',
        message: expect.stringContaining('5 minutes'),
      });
      w.stop();
    });
  });

  describe('loadDeployWatchdogConfig', () => {
    const originalInterval = process.env.DEPLOY_WATCHDOG_INTERVAL_MS;
    const originalThreshold = process.env.DEPLOY_WATCHDOG_TIMEOUT_MINUTES;

    afterEach(() => {
      if (originalInterval === undefined) delete process.env.DEPLOY_WATCHDOG_INTERVAL_MS;
      else process.env.DEPLOY_WATCHDOG_INTERVAL_MS = originalInterval;
      if (originalThreshold === undefined) delete process.env.DEPLOY_WATCHDOG_TIMEOUT_MINUTES;
      else process.env.DEPLOY_WATCHDOG_TIMEOUT_MINUTES = originalThreshold;
    });

    it('falls back to defaults when env vars are unset', () => {
      delete process.env.DEPLOY_WATCHDOG_INTERVAL_MS;
      delete process.env.DEPLOY_WATCHDOG_TIMEOUT_MINUTES;
      const cfg = loadDeployWatchdogConfig();
      expect(cfg.intervalMs).toBe(2 * 60 * 1000);
      expect(cfg.thresholdMinutes).toBe(20);
    });

    it('reads env vars when provided', () => {
      process.env.DEPLOY_WATCHDOG_INTERVAL_MS = '5000';
      process.env.DEPLOY_WATCHDOG_TIMEOUT_MINUTES = '15';
      const cfg = loadDeployWatchdogConfig();
      expect(cfg.intervalMs).toBe(5000);
      expect(cfg.thresholdMinutes).toBe(15);
    });

    it('falls back to defaults for invalid values', () => {
      process.env.DEPLOY_WATCHDOG_INTERVAL_MS = 'not-a-number';
      process.env.DEPLOY_WATCHDOG_TIMEOUT_MINUTES = '-5';
      const cfg = loadDeployWatchdogConfig();
      expect(cfg.intervalMs).toBe(2 * 60 * 1000);
      expect(cfg.thresholdMinutes).toBe(20);
    });

    it('treats 0 as invalid and falls back to defaults', () => {
      process.env.DEPLOY_WATCHDOG_INTERVAL_MS = '0';
      process.env.DEPLOY_WATCHDOG_TIMEOUT_MINUTES = '0';
      const cfg = loadDeployWatchdogConfig();
      expect(cfg.intervalMs).toBe(2 * 60 * 1000);
      expect(cfg.thresholdMinutes).toBe(20);
    });

    it('floors fractional values', () => {
      process.env.DEPLOY_WATCHDOG_INTERVAL_MS = '1234.9';
      process.env.DEPLOY_WATCHDOG_TIMEOUT_MINUTES = '10.7';
      const cfg = loadDeployWatchdogConfig();
      expect(cfg.intervalMs).toBe(1234);
      expect(cfg.thresholdMinutes).toBe(10);
    });
  });

  describe('constructor guards', () => {
    it('throws when intervalMs is 0 or negative', () => {
      expect(() => new DeployWatchdog({ intervalMs: 0, thresholdMinutes: 10 })).toThrow(/intervalMs/);
      expect(() => new DeployWatchdog({ intervalMs: -1, thresholdMinutes: 10 })).toThrow(/intervalMs/);
    });

    it('throws when thresholdMinutes is 0 or negative', () => {
      expect(() => new DeployWatchdog({ intervalMs: 1000, thresholdMinutes: 0 })).toThrow(/thresholdMinutes/);
      expect(() => new DeployWatchdog({ intervalMs: 1000, thresholdMinutes: -5 })).toThrow(/thresholdMinutes/);
    });

    it('throws when values are non-finite', () => {
      expect(() => new DeployWatchdog({ intervalMs: Number.POSITIVE_INFINITY, thresholdMinutes: 10 })).toThrow();
      expect(() => new DeployWatchdog({ intervalMs: 1000, thresholdMinutes: Number.NaN })).toThrow();
    });
  });
});
