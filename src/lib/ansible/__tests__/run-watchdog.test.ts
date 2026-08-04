import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';
import type { AnsibleBroadcastEvent } from '@/lib/ansible/run-broadcast-service';
import {
  AnsibleRunWatchdog,
  loadAnsibleRunWatchdogConfig,
  type AnsibleWatchdogRepo,
} from '../run-watchdog';

interface IntervalHandle {
  cb: () => void;
  ms: number;
  cleared: boolean;
}

function createIntervalHarness() {
  const intervals: IntervalHandle[] = [];
  const setSpy = spyOn(globalThis, 'setInterval').mockImplementation(((
    cb: () => void,
    ms: number,
  ) => {
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

function createRepoMock(overrides: Partial<AnsibleWatchdogRepo> = {}): AnsibleWatchdogRepo {
  return {
    timeoutStuckRuns: mock().mockResolvedValue([]) as unknown as AnsibleWatchdogRepo['timeoutStuckRuns'],
    ...overrides,
  };
}

function createPublishRecorder() {
  const events: AnsibleBroadcastEvent[] = [];
  return {
    events,
    publish: (event: AnsibleBroadcastEvent) => {
      events.push(event);
    },
  };
}

describe('AnsibleRunWatchdog', () => {
  let harness: ReturnType<typeof createIntervalHarness>;

  beforeEach(() => {
    harness = createIntervalHarness();
  });

  afterEach(() => {
    harness.restore();
  });

  describe('start / stop', () => {
    it('registers a setInterval with the configured interval', () => {
      const w = new AnsibleRunWatchdog({ intervalMs: 500, thresholdMinutes: 10 });
      w.start(createRepoMock(), createPublishRecorder().publish);
      expect(harness.intervals).toHaveLength(1);
      expect(harness.intervals[0].ms).toBe(500);
      w.stop();
    });

    it('is a no-op when start is called twice', () => {
      const w = new AnsibleRunWatchdog({ intervalMs: 500, thresholdMinutes: 10 });
      const repo = createRepoMock();
      const { publish } = createPublishRecorder();
      w.start(repo, publish);
      w.start(repo, publish);
      expect(harness.intervals).toHaveLength(1);
      w.stop();
    });

    it('clears the interval on stop', () => {
      const w = new AnsibleRunWatchdog({ intervalMs: 500, thresholdMinutes: 10 });
      w.start(createRepoMock(), createPublishRecorder().publish);
      w.stop();
      expect(harness.intervals[0].cleared).toBe(true);
    });

    it('is a no-op when stop is called before start', () => {
      const w = new AnsibleRunWatchdog({ intervalMs: 500, thresholdMinutes: 10 });
      expect(() => w.stop()).not.toThrow();
      expect(harness.clearSpy).not.toHaveBeenCalled();
    });

    it('can be restarted after stop', () => {
      const w = new AnsibleRunWatchdog({ intervalMs: 500, thresholdMinutes: 10 });
      const repo = createRepoMock();
      const { publish } = createPublishRecorder();
      w.start(repo, publish);
      w.stop();
      w.start(repo, publish);
      expect(harness.intervals).toHaveLength(2);
      w.stop();
    });
  });

  describe('tick', () => {
    it('calls timeoutStuckRuns with the configured threshold', async () => {
      const timeoutStuckRuns = mock().mockResolvedValue([]);
      const repo = createRepoMock({
        timeoutStuckRuns,
      } as Partial<AnsibleWatchdogRepo>);
      const w = new AnsibleRunWatchdog({ intervalMs: 1000, thresholdMinutes: 45 });

      await w.tick(repo, createPublishRecorder().publish);

      expect(timeoutStuckRuns).toHaveBeenCalledTimes(1);
      expect(timeoutStuckRuns.mock.calls[0]).toEqual([45]);
    });

    it('publishes run_finished with a failed status for each timed-out row', async () => {
      const repo = createRepoMock({
        timeoutStuckRuns: mock().mockResolvedValue([
          { id: 1, runId: 'run-a' },
          { id: 2, runId: 'run-b' },
        ]) as unknown as AnsibleWatchdogRepo['timeoutStuckRuns'],
      });
      const recorder = createPublishRecorder();
      const infoSpy = spyOn(console, 'info').mockImplementation(() => {});

      const w = new AnsibleRunWatchdog({ intervalMs: 1000, thresholdMinutes: 30 });
      await w.tick(repo, recorder.publish);

      expect(recorder.events).toEqual([
        { type: 'run_finished', runId: 'run-a', status: 'failed' },
        { type: 'run_finished', runId: 'run-b', status: 'failed' },
      ]);
      expect(String(infoSpy.mock.calls.at(-1)?.[0])).toContain('30 minutes');
      expect(String(infoSpy.mock.calls.at(-1)?.[0])).toContain('run-a, run-b');
      infoSpy.mockRestore();
    });

    it('does not publish when no runs are stuck', async () => {
      const repo = createRepoMock();
      const recorder = createPublishRecorder();

      const w = new AnsibleRunWatchdog({ intervalMs: 1000, thresholdMinutes: 30 });
      await w.tick(repo, recorder.publish);

      expect(recorder.events).toEqual([]);
    });

    it('swallows publish errors so one bad row does not break the sweep', async () => {
      const repo = createRepoMock({
        timeoutStuckRuns: mock().mockResolvedValue([
          { id: 1, runId: 'run-a' },
          { id: 2, runId: 'run-b' },
        ]) as unknown as AnsibleWatchdogRepo['timeoutStuckRuns'],
      });
      const seen: string[] = [];
      const publish = mock((event: AnsibleBroadcastEvent) => {
        seen.push(event.runId);
        if (event.runId === 'run-a') throw new Error('subscriber blew up');
      });
      const errSpy = spyOn(console, 'error').mockImplementation(() => {});
      const infoSpy = spyOn(console, 'info').mockImplementation(() => {});

      const w = new AnsibleRunWatchdog({ intervalMs: 1000, thresholdMinutes: 30 });
      await expect(w.tick(repo, publish)).resolves.toBeUndefined();

      expect(seen).toEqual(['run-a', 'run-b']);
      expect(errSpy).toHaveBeenCalled();
      errSpy.mockRestore();
      infoSpy.mockRestore();
    });

    it('logs and swallows timeoutStuckRuns errors', async () => {
      const repo = createRepoMock({
        timeoutStuckRuns: mock().mockRejectedValue(
          new Error('db is sad'),
        ) as unknown as AnsibleWatchdogRepo['timeoutStuckRuns'],
      });
      const errSpy = spyOn(console, 'error').mockImplementation(() => {});

      const w = new AnsibleRunWatchdog({ intervalMs: 1000, thresholdMinutes: 30 });
      await expect(w.tick(repo, createPublishRecorder().publish)).resolves.toBeUndefined();
      expect(errSpy).toHaveBeenCalled();
      errSpy.mockRestore();
    });

    it('is reentrancy-safe: a second call while a tick is running is ignored', async () => {
      let resolveFirst!: (v: unknown[]) => void;
      const timeoutStuckRuns = mock().mockImplementation(
        () =>
          new Promise((r) => {
            resolveFirst = r as (v: unknown[]) => void;
          }),
      );
      const repo = createRepoMock({ timeoutStuckRuns } as Partial<AnsibleWatchdogRepo>);
      const { publish } = createPublishRecorder();
      const infoSpy = spyOn(console, 'info').mockImplementation(() => {});
      const w = new AnsibleRunWatchdog({ intervalMs: 1000, thresholdMinutes: 30 });

      const firstTick = w.tick(repo, publish);
      await w.tick(repo, publish);
      expect(timeoutStuckRuns).toHaveBeenCalledTimes(1);
      expect(w.getSkippedTicks()).toBe(1);

      resolveFirst([]);
      await firstTick;
      infoSpy.mockRestore();
    });

    it('releases the reentrancy guard after the first tick completes', async () => {
      const timeoutStuckRuns = mock().mockResolvedValue([]);
      const repo = createRepoMock({ timeoutStuckRuns } as Partial<AnsibleWatchdogRepo>);
      const { publish } = createPublishRecorder();
      const w = new AnsibleRunWatchdog({ intervalMs: 1000, thresholdMinutes: 30 });

      await w.tick(repo, publish);
      await w.tick(repo, publish);
      expect(timeoutStuckRuns).toHaveBeenCalledTimes(2);
      expect(w.getSkippedTicks()).toBe(0);
    });

    it('tracks consecutive failures and escalates the log prefix past the threshold', async () => {
      const repo = createRepoMock({
        timeoutStuckRuns: mock().mockRejectedValue(
          new Error('db is sad'),
        ) as unknown as AnsibleWatchdogRepo['timeoutStuckRuns'],
      });
      const { publish } = createPublishRecorder();
      const errSpy = spyOn(console, 'error').mockImplementation(() => {});

      const w = new AnsibleRunWatchdog({ intervalMs: 1000, thresholdMinutes: 30 });
      await w.tick(repo, publish);
      await w.tick(repo, publish);
      expect(w.getConsecutiveFailures()).toBe(2);
      expect(errSpy.mock.calls.at(-1)?.[0]).not.toContain('consecutive failures');

      await w.tick(repo, publish);
      expect(w.getConsecutiveFailures()).toBe(3);
      expect(errSpy.mock.calls.at(-1)?.[0]).toContain('3 consecutive failures');
      expect(errSpy.mock.calls.at(-1)?.[0]).toContain('degraded');

      errSpy.mockRestore();
    });

    it('resets the consecutive failure counter after a successful tick', async () => {
      const timeoutStuckRuns = mock()
        .mockRejectedValueOnce(new Error('fail'))
        .mockRejectedValueOnce(new Error('fail'))
        .mockResolvedValueOnce([]);
      const repo = createRepoMock({ timeoutStuckRuns } as Partial<AnsibleWatchdogRepo>);
      const { publish } = createPublishRecorder();
      const errSpy = spyOn(console, 'error').mockImplementation(() => {});

      const w = new AnsibleRunWatchdog({ intervalMs: 1000, thresholdMinutes: 30 });
      await w.tick(repo, publish);
      await w.tick(repo, publish);
      expect(w.getConsecutiveFailures()).toBe(2);

      await w.tick(repo, publish);
      expect(w.getConsecutiveFailures()).toBe(0);

      errSpy.mockRestore();
    });
  });

  describe('interval firing', () => {
    it('invokes tick when the interval callback runs', async () => {
      const timeoutStuckRuns = mock().mockResolvedValue([{ id: 9, runId: 'run-9' }]);
      const repo = createRepoMock({ timeoutStuckRuns } as Partial<AnsibleWatchdogRepo>);
      const events: AnsibleBroadcastEvent[] = [];
      let signalPublished!: () => void;
      const published = new Promise<void>((resolve) => {
        signalPublished = resolve;
      });
      const infoSpy = spyOn(console, 'info').mockImplementation(() => {});

      const w = new AnsibleRunWatchdog({ intervalMs: 100, thresholdMinutes: 5 });
      w.start(repo, (event) => {
        events.push(event);
        signalPublished();
      });
      expect(harness.intervals).toHaveLength(1);

      harness.intervals[0].cb();
      await published;

      expect(timeoutStuckRuns).toHaveBeenCalledTimes(1);
      expect(events).toEqual([{ type: 'run_finished', runId: 'run-9', status: 'failed' }]);
      w.stop();
      infoSpy.mockRestore();
    });
  });

  describe('loadAnsibleRunWatchdogConfig', () => {
    const originalInterval = process.env.ANSIBLE_WATCHDOG_INTERVAL_MS;
    const originalThreshold = process.env.ANSIBLE_WATCHDOG_TIMEOUT_MINUTES;

    afterEach(() => {
      if (originalInterval === undefined) delete process.env.ANSIBLE_WATCHDOG_INTERVAL_MS;
      else process.env.ANSIBLE_WATCHDOG_INTERVAL_MS = originalInterval;
      if (originalThreshold === undefined) delete process.env.ANSIBLE_WATCHDOG_TIMEOUT_MINUTES;
      else process.env.ANSIBLE_WATCHDOG_TIMEOUT_MINUTES = originalThreshold;
    });

    it('falls back to defaults when env vars are unset', () => {
      delete process.env.ANSIBLE_WATCHDOG_INTERVAL_MS;
      delete process.env.ANSIBLE_WATCHDOG_TIMEOUT_MINUTES;
      const cfg = loadAnsibleRunWatchdogConfig();
      expect(cfg.intervalMs).toBe(2 * 60 * 1000);
      expect(cfg.thresholdMinutes).toBe(15);
    });

    it('reads env vars when provided', () => {
      process.env.ANSIBLE_WATCHDOG_INTERVAL_MS = '5000';
      process.env.ANSIBLE_WATCHDOG_TIMEOUT_MINUTES = '25';
      const cfg = loadAnsibleRunWatchdogConfig();
      expect(cfg.intervalMs).toBe(5000);
      expect(cfg.thresholdMinutes).toBe(25);
    });

    it('falls back to defaults for invalid values', () => {
      process.env.ANSIBLE_WATCHDOG_INTERVAL_MS = 'not-a-number';
      process.env.ANSIBLE_WATCHDOG_TIMEOUT_MINUTES = '-5';
      const cfg = loadAnsibleRunWatchdogConfig();
      expect(cfg.intervalMs).toBe(2 * 60 * 1000);
      expect(cfg.thresholdMinutes).toBe(15);
    });

    it('treats 0 as invalid and falls back to defaults', () => {
      process.env.ANSIBLE_WATCHDOG_INTERVAL_MS = '0';
      process.env.ANSIBLE_WATCHDOG_TIMEOUT_MINUTES = '0';
      const cfg = loadAnsibleRunWatchdogConfig();
      expect(cfg.intervalMs).toBe(2 * 60 * 1000);
      expect(cfg.thresholdMinutes).toBe(15);
    });

    it('floors fractional values', () => {
      process.env.ANSIBLE_WATCHDOG_INTERVAL_MS = '1234.9';
      process.env.ANSIBLE_WATCHDOG_TIMEOUT_MINUTES = '10.7';
      const cfg = loadAnsibleRunWatchdogConfig();
      expect(cfg.intervalMs).toBe(1234);
      expect(cfg.thresholdMinutes).toBe(10);
    });
  });

  describe('constructor guards', () => {
    it('throws when intervalMs is 0 or negative', () => {
      expect(() => new AnsibleRunWatchdog({ intervalMs: 0, thresholdMinutes: 10 })).toThrow(
        /intervalMs/,
      );
      expect(() => new AnsibleRunWatchdog({ intervalMs: -1, thresholdMinutes: 10 })).toThrow(
        /intervalMs/,
      );
    });

    it('throws when thresholdMinutes is 0 or negative', () => {
      expect(() => new AnsibleRunWatchdog({ intervalMs: 1000, thresholdMinutes: 0 })).toThrow(
        /thresholdMinutes/,
      );
      expect(() => new AnsibleRunWatchdog({ intervalMs: 1000, thresholdMinutes: -5 })).toThrow(
        /thresholdMinutes/,
      );
    });

    it('throws when values are non-finite', () => {
      expect(
        () =>
          new AnsibleRunWatchdog({
            intervalMs: Number.POSITIVE_INFINITY,
            thresholdMinutes: 10,
          }),
      ).toThrow();
      expect(
        () => new AnsibleRunWatchdog({ intervalMs: 1000, thresholdMinutes: Number.NaN }),
      ).toThrow();
    });
  });
});
