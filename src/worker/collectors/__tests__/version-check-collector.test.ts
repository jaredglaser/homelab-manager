import { describe, it, expect, mock, beforeEach, afterEach, spyOn } from 'bun:test';
import { VersionCheckCollector } from '../version-check-collector';
import type { DatabaseClient } from '@/lib/clients/database-client';
import type { WorkerConfig } from '@/lib/config/worker-config';
import type { Pool } from 'pg';

const originalConsoleLog = console.log;
const originalConsoleError = console.error;

function createMockDb() {
  return {
    id: 'test',
    getPool: () => ({}) as unknown as Pool,
    connect: mock(async () => {}),
    isConnected: () => true,
    close: mock(async () => {}),
  };
}

function createMockConfig(): WorkerConfig {
  return {
    enabled: true,
    docker: { enabled: false },
    zfs: { enabled: false },
    proxmox: { enabled: false },
    collection: { interval: 1000 },
    versionCheck: { enabled: true, interval: 86400000 },
  };
}

describe('VersionCheckCollector', () => {
  beforeEach(() => {
    console.log = mock(() => {});
    console.error = mock(() => {});
  });

  afterEach(() => {
    console.log = originalConsoleLog;
    console.error = originalConsoleError;
  });

  describe('construction', () => {
    it('should set name to VersionCheck', () => {
      const db = createMockDb();
      const controller = new AbortController();
      const collector = new VersionCheckCollector(db as unknown as DatabaseClient, createMockConfig(), controller);

      expect(collector.name).toBe('VersionCheck');
      controller.abort();
    });

    it('should implement AsyncDisposable', async () => {
      const db = createMockDb();
      const controller = new AbortController();
      const collector = new VersionCheckCollector(db as unknown as DatabaseClient, createMockConfig(), controller);

      expect(Symbol.asyncDispose in collector).toBe(true);
      await collector[Symbol.asyncDispose]();
    });
  });

  describe('handleCommand', () => {
    it('should set _triggerCheck to true on "start" command', () => {
      const db = createMockDb();
      const controller = new AbortController();
      const collector = new VersionCheckCollector(db as unknown as DatabaseClient, createMockConfig(), controller);

      collector.handleCommand('start');
      expect((collector as any)._triggerCheck).toBe(true);

      controller.abort();
    });

    it('should set _cancelCheck to true on "stop" command', () => {
      const db = createMockDb();
      const controller = new AbortController();
      const collector = new VersionCheckCollector(db as unknown as DatabaseClient, createMockConfig(), controller);

      collector.handleCommand('stop');
      expect((collector as any)._cancelCheck).toBe(true);

      controller.abort();
    });

    it('should not set flags on unknown command', () => {
      const db = createMockDb();
      const controller = new AbortController();
      const collector = new VersionCheckCollector(db as unknown as DatabaseClient, createMockConfig(), controller);

      collector.handleCommand('unknown');
      expect((collector as any)._triggerCheck).toBe(false);
      expect((collector as any)._cancelCheck).toBe(false);

      controller.abort();
    });

    it('should not set flags on null command', () => {
      const db = createMockDb();
      const controller = new AbortController();
      const collector = new VersionCheckCollector(db as unknown as DatabaseClient, createMockConfig(), controller);

      collector.handleCommand(null);
      expect((collector as any)._triggerCheck).toBe(false);
      expect((collector as any)._cancelCheck).toBe(false);

      controller.abort();
    });
  });

  describe('runVersionCheck', () => {
    it('should update status to idle when no images found', async () => {
      const db = createMockDb();
      const controller = new AbortController();
      const collector = new VersionCheckCollector(db as unknown as DatabaseClient, createMockConfig(), controller);

      spyOn((collector as any).repository, 'getUniqueDockerImages').mockResolvedValue([]);
      const settingsSetSpy = spyOn((collector as any).settingsRepo, 'set').mockResolvedValue(undefined);

      await (collector as any).runVersionCheck();

      // Should have called set for 'running' status, '0/0' progress, clear command, then 'idle' status + clear command
      const statusCalls = settingsSetSpy.mock.calls.filter(
        (c: any[]) => c[0] === 'versionCheck/status'
      );
      expect(statusCalls.length).toBeGreaterThanOrEqual(2);
      expect(statusCalls[0][1]).toBe('running');
      expect(statusCalls[statusCalls.length - 1][1]).toBe('idle');

      controller.abort();
    });

    it('should deduplicate images and check each unique one', async () => {
      const db = createMockDb();
      const controller = new AbortController();
      const collector = new VersionCheckCollector(db as unknown as DatabaseClient, createMockConfig(), controller);

      spyOn((collector as any).repository, 'getUniqueDockerImages').mockResolvedValue([
        { image: 'nginx:latest', entity: 'host1/abc' },
        { image: 'nginx:latest', entity: 'host1/def' },
        { image: 'redis:7', entity: 'host1/ghi' },
      ]);
      spyOn((collector as any).settingsRepo, 'set').mockResolvedValue(undefined);

      const checkImageSpy = spyOn(collector as any, 'checkImage').mockResolvedValue(undefined);

      await (collector as any).runVersionCheck();

      // Only 2 unique images
      expect(checkImageSpy).toHaveBeenCalledTimes(2);
      expect(checkImageSpy.mock.calls[0]).toEqual(['nginx:latest', 'host1/abc']);
      expect(checkImageSpy.mock.calls[1]).toEqual(['redis:7', 'host1/ghi']);

      controller.abort();
    });

    it('should stop checking when cancelled', async () => {
      const db = createMockDb();
      const controller = new AbortController();
      const collector = new VersionCheckCollector(db as unknown as DatabaseClient, createMockConfig(), controller);

      spyOn((collector as any).repository, 'getUniqueDockerImages').mockResolvedValue([
        { image: 'nginx:latest', entity: 'host1/abc' },
        { image: 'redis:7', entity: 'host1/def' },
      ]);
      spyOn((collector as any).settingsRepo, 'set').mockResolvedValue(undefined);

      // Cancel after the first checkImage call
      const checkImageSpy = spyOn(collector as any, 'checkImage').mockImplementation(async () => {
        (collector as any)._cancelCheck = true;
      });

      await (collector as any).runVersionCheck();

      // Should have only checked the first image before cancelling
      expect(checkImageSpy).toHaveBeenCalledTimes(1);

      controller.abort();
    });

    it('should stop checking when signal is aborted', async () => {
      const db = createMockDb();
      const controller = new AbortController();
      const collector = new VersionCheckCollector(db as unknown as DatabaseClient, createMockConfig(), controller);

      spyOn((collector as any).repository, 'getUniqueDockerImages').mockResolvedValue([
        { image: 'nginx:latest', entity: 'host1/abc' },
        { image: 'redis:7', entity: 'host1/def' },
      ]);
      spyOn((collector as any).settingsRepo, 'set').mockResolvedValue(undefined);

      const checkImageSpy = spyOn(collector as any, 'checkImage').mockImplementation(async () => {
        controller.abort();
      });

      await (collector as any).runVersionCheck();

      expect(checkImageSpy).toHaveBeenCalledTimes(1);
    });

    it('should continue checking when individual checkImage throws', async () => {
      const db = createMockDb();
      const controller = new AbortController();
      const collector = new VersionCheckCollector(db as unknown as DatabaseClient, createMockConfig(), controller);

      spyOn((collector as any).repository, 'getUniqueDockerImages').mockResolvedValue([
        { image: 'bad:image', entity: 'host1/abc' },
        { image: 'good:image', entity: 'host1/def' },
      ]);
      spyOn((collector as any).settingsRepo, 'set').mockResolvedValue(undefined);

      let callCount = 0;
      const checkImageSpy = spyOn(collector as any, 'checkImage').mockImplementation(async () => {
        callCount++;
        if (callCount === 1) throw new Error('GitHub API error');
      });

      await (collector as any).runVersionCheck();

      expect(checkImageSpy).toHaveBeenCalledTimes(2);

      controller.abort();
    });

    it('should set lastRun on successful completion', async () => {
      const db = createMockDb();
      const controller = new AbortController();
      const collector = new VersionCheckCollector(db as unknown as DatabaseClient, createMockConfig(), controller);

      spyOn((collector as any).repository, 'getUniqueDockerImages').mockResolvedValue([
        { image: 'nginx:latest', entity: 'host1/abc' },
      ]);
      const settingsSetSpy = spyOn((collector as any).settingsRepo, 'set').mockResolvedValue(undefined);
      spyOn(collector as any, 'checkImage').mockResolvedValue(undefined);

      await (collector as any).runVersionCheck();

      const lastRunCalls = settingsSetSpy.mock.calls.filter(
        (c: any[]) => c[0] === 'versionCheck/lastRun'
      );
      expect(lastRunCalls.length).toBe(1);

      controller.abort();
    });

    it('should handle top-level error and update status to idle', async () => {
      const db = createMockDb();
      const controller = new AbortController();
      const collector = new VersionCheckCollector(db as unknown as DatabaseClient, createMockConfig(), controller);

      spyOn((collector as any).repository, 'getUniqueDockerImages').mockRejectedValue(new Error('DB down'));
      const settingsSetSpy = spyOn((collector as any).settingsRepo, 'set').mockResolvedValue(undefined);

      await (collector as any).runVersionCheck();

      const statusCalls = settingsSetSpy.mock.calls.filter(
        (c: any[]) => c[0] === 'versionCheck/status'
      );
      expect(statusCalls[statusCalls.length - 1][1]).toBe('idle');

      controller.abort();
    });
  });

  describe('checkImage', () => {
    it('should upsert with null github info when no repo found', async () => {
      const db = createMockDb();
      const controller = new AbortController();
      const collector = new VersionCheckCollector(db as unknown as DatabaseClient, createMockConfig(), controller);

      spyOn((collector as any).repository, 'getEntityMetadataValue').mockResolvedValue(null);
      const upsertSpy = spyOn((collector as any).repository, 'upsertContainerVersion').mockResolvedValue(undefined);

      await (collector as any).checkImage('nginx:1.25', 'host1/abc');

      expect(upsertSpy).toHaveBeenCalledTimes(1);
      expect(upsertSpy.mock.calls[0]).toEqual([
        'nginx:1.25', '1.25', null, false, null, null, [],
      ]);

      controller.abort();
    });

    it('should use manual override when available', async () => {
      const db = createMockDb();
      const controller = new AbortController();
      const collector = new VersionCheckCollector(db as unknown as DatabaseClient, createMockConfig(), controller);

      const getMetaSpy = spyOn((collector as any).repository, 'getEntityMetadataValue')
        .mockImplementation(async (_source: string, _entity: string, key: string) => {
          if (key === 'github_repo_override') return 'https://github.com/jaredglaser/homelab-manager';
          return null;
        });

      const upsertSpy = spyOn((collector as any).repository, 'upsertContainerVersion').mockResolvedValue(undefined);

      // Mock global fetch for fetchGitHubReleases
      const originalFetch = globalThis.fetch;
      globalThis.fetch = mock(async () => new Response(JSON.stringify([
        { tag_name: 'v1.26', name: 'v1.26', body: 'Release', published_at: '2024-01-01', html_url: 'https://github.com/jaredglaser/homelab-manager/releases/v1.26', prerelease: false },
      ]), {
        status: 200,
        headers: { 'x-ratelimit-remaining': '59', 'x-ratelimit-reset': '1700000000' },
      })) as unknown as typeof fetch;

      try {
        await (collector as any).checkImage('nginx:1.25', 'host1/abc');

        expect(getMetaSpy.mock.calls[0][2]).toBe('github_repo_override');
        expect(upsertSpy).toHaveBeenCalledTimes(1);
        expect(upsertSpy.mock.calls[0][4]).toBe('jaredglaser/homelab-manager');
        expect(upsertSpy.mock.calls[0][5]).toBe('manual');
      } finally {
        globalThis.fetch = originalFetch;
      }

      controller.abort();
    });

    it('should fall back to OCI label when no manual override', async () => {
      const db = createMockDb();
      const controller = new AbortController();
      const collector = new VersionCheckCollector(db as unknown as DatabaseClient, createMockConfig(), controller);

      spyOn((collector as any).repository, 'getEntityMetadataValue')
        .mockImplementation(async (_source: string, _entity: string, key: string) => {
          if (key === 'github_repo_override') return null;
          if (key === 'oci_image_source') return 'https://github.com/jaredglaser/homelab-manager';
          return null;
        });

      const upsertSpy = spyOn((collector as any).repository, 'upsertContainerVersion').mockResolvedValue(undefined);

      const originalFetch = globalThis.fetch;
      globalThis.fetch = mock(async () => new Response(JSON.stringify([
        { tag_name: 'v4.0', name: 'v4.0', body: '', published_at: '2024-01-01', html_url: 'url', prerelease: false },
      ]), {
        status: 200,
        headers: { 'x-ratelimit-remaining': '59', 'x-ratelimit-reset': '1700000000' },
      })) as unknown as typeof fetch;

      try {
        await (collector as any).checkImage('ghcr.io/jaredglaser/homelab-manager:latest', 'host1/abc');

        expect(upsertSpy.mock.calls[0][4]).toBe('jaredglaser/homelab-manager');
        expect(upsertSpy.mock.calls[0][5]).toBe('oci_label');
      } finally {
        globalThis.fetch = originalFetch;
      }

      controller.abort();
    });

    it('should mark update available when latest tag differs from current', async () => {
      const db = createMockDb();
      const controller = new AbortController();
      const collector = new VersionCheckCollector(db as unknown as DatabaseClient, createMockConfig(), controller);

      spyOn((collector as any).repository, 'getEntityMetadataValue')
        .mockImplementation(async (_source: string, _entity: string, key: string) => {
          if (key === 'github_repo_override') return 'https://github.com/jaredglaser/homelab-manager';
          return null;
        });

      const upsertSpy = spyOn((collector as any).repository, 'upsertContainerVersion').mockResolvedValue(undefined);

      const originalFetch = globalThis.fetch;
      globalThis.fetch = mock(async () => new Response(JSON.stringify([
        { tag_name: 'v2.0', name: 'v2.0', body: '', published_at: '2024-01-01', html_url: 'url', prerelease: false },
      ]), {
        status: 200,
        headers: { 'x-ratelimit-remaining': '59', 'x-ratelimit-reset': '1700000000' },
      })) as unknown as typeof fetch;

      try {
        await (collector as any).checkImage('myimage:v1.0', 'host1/abc');

        // latestTag='v2.0', currentTag='v1.0' -> updateAvailable=true
        expect(upsertSpy.mock.calls[0][1]).toBe('v1.0'); // currentTag
        expect(upsertSpy.mock.calls[0][2]).toBe('v2.0'); // latestTag
        expect(upsertSpy.mock.calls[0][3]).toBe(true);   // updateAvailable
      } finally {
        globalThis.fetch = originalFetch;
      }

      controller.abort();
    });

    it('should not mark update when tags match', async () => {
      const db = createMockDb();
      const controller = new AbortController();
      const collector = new VersionCheckCollector(db as unknown as DatabaseClient, createMockConfig(), controller);

      spyOn((collector as any).repository, 'getEntityMetadataValue')
        .mockImplementation(async (_source: string, _entity: string, key: string) => {
          if (key === 'github_repo_override') return 'https://github.com/jaredglaser/homelab-manager';
          return null;
        });

      const upsertSpy = spyOn((collector as any).repository, 'upsertContainerVersion').mockResolvedValue(undefined);

      const originalFetch = globalThis.fetch;
      globalThis.fetch = mock(async () => new Response(JSON.stringify([
        { tag_name: 'v1.0', name: 'v1.0', body: '', published_at: '2024-01-01', html_url: 'url', prerelease: false },
      ]), {
        status: 200,
        headers: { 'x-ratelimit-remaining': '59', 'x-ratelimit-reset': '1700000000' },
      })) as unknown as typeof fetch;

      try {
        await (collector as any).checkImage('myimage:v1.0', 'host1/abc');

        expect(upsertSpy.mock.calls[0][2]).toBe('v1.0');
        expect(upsertSpy.mock.calls[0][3]).toBe(false); // updateAvailable=false
      } finally {
        globalThis.fetch = originalFetch;
      }

      controller.abort();
    });

    it('should handle rate limiting and update status', async () => {
      const db = createMockDb();
      const controller = new AbortController();
      const collector = new VersionCheckCollector(db as unknown as DatabaseClient, createMockConfig(), controller);

      spyOn((collector as any).repository, 'getEntityMetadataValue')
        .mockImplementation(async (_source: string, _entity: string, key: string) => {
          if (key === 'github_repo_override') return 'https://github.com/jaredglaser/homelab-manager';
          return null;
        });

      const upsertSpy = spyOn((collector as any).repository, 'upsertContainerVersion').mockResolvedValue(undefined);
      const settingsSetSpy = spyOn((collector as any).settingsRepo, 'set').mockResolvedValue(undefined);

      const originalFetch = globalThis.fetch;
      globalThis.fetch = mock(async () => new Response('rate limited', {
        status: 429,
        headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '0' },
      })) as unknown as typeof fetch;

      try {
        await (collector as any).checkImage('myimage:v1.0', 'host1/abc');

        // Should NOT upsert when rate limited
        expect(upsertSpy).not.toHaveBeenCalled();

        // Should set status to rate_limited
        const statusCalls = settingsSetSpy.mock.calls.filter(
          (c: any[]) => c[0] === 'versionCheck/status'
        );
        expect(statusCalls.some((c: any[]) => c[1] === 'rate_limited')).toBe(true);
      } finally {
        globalThis.fetch = originalFetch;
      }

      controller.abort();
    });

    it('should handle empty releases list', async () => {
      const db = createMockDb();
      const controller = new AbortController();
      const collector = new VersionCheckCollector(db as unknown as DatabaseClient, createMockConfig(), controller);

      spyOn((collector as any).repository, 'getEntityMetadataValue')
        .mockImplementation(async (_source: string, _entity: string, key: string) => {
          if (key === 'github_repo_override') return 'https://github.com/jaredglaser/homelab-manager';
          return null;
        });

      const upsertSpy = spyOn((collector as any).repository, 'upsertContainerVersion').mockResolvedValue(undefined);

      const originalFetch = globalThis.fetch;
      globalThis.fetch = mock(async () => new Response(JSON.stringify([]), {
        status: 200,
        headers: { 'x-ratelimit-remaining': '59', 'x-ratelimit-reset': '1700000000' },
      })) as unknown as typeof fetch;

      try {
        await (collector as any).checkImage('myimage:v1.0', 'host1/abc');

        // latestTag should be null, updateAvailable false
        expect(upsertSpy.mock.calls[0][2]).toBeNull();
        expect(upsertSpy.mock.calls[0][3]).toBe(false);
      } finally {
        globalThis.fetch = originalFetch;
      }

      controller.abort();
    });
  });

  describe('collect (via run)', () => {
    it('should call runVersionCheck and then sleep until aborted', async () => {
      const db = createMockDb();
      const controller = new AbortController();
      const collector = new VersionCheckCollector(db as unknown as DatabaseClient, createMockConfig(), controller);

      const runCheckSpy = spyOn(collector as any, 'runVersionCheck').mockResolvedValue(undefined);

      // Abort after a tiny delay so the sleep loop ends
      setTimeout(() => controller.abort(), 50);

      await collector.run();

      expect(runCheckSpy).toHaveBeenCalledTimes(1);
    });

    it('should re-run version check when triggerCheck is set during sleep', async () => {
      const db = createMockDb();
      const controller = new AbortController();
      const config = createMockConfig();
      config.versionCheck.interval = 100; // Short interval for test
      const collector = new VersionCheckCollector(db as unknown as DatabaseClient, config, controller);

      let checkCount = 0;
      spyOn(collector as any, 'runVersionCheck').mockImplementation(async () => {
        checkCount++;
        if (checkCount === 1) {
          // After first check, set triggerCheck during the sleep phase
          setTimeout(() => {
            (collector as any)._triggerCheck = true;
          }, 10);
        } else if (checkCount >= 2) {
          // After second check, abort to end the test
          controller.abort();
        }
      });

      await collector.run();

      expect(checkCount).toBeGreaterThanOrEqual(2);
    });
  });

  describe('updateStatus', () => {
    it('should silently handle errors in settings updates', async () => {
      const db = createMockDb();
      const controller = new AbortController();
      const collector = new VersionCheckCollector(db as unknown as DatabaseClient, createMockConfig(), controller);

      spyOn((collector as any).settingsRepo, 'set').mockRejectedValue(new Error('DB error'));

      // Should not throw
      await (collector as any).updateStatus('running', '0/5');

      controller.abort();
    });

    it('should set status and progress when provided', async () => {
      const db = createMockDb();
      const controller = new AbortController();
      const collector = new VersionCheckCollector(db as unknown as DatabaseClient, createMockConfig(), controller);

      const setSpy = spyOn((collector as any).settingsRepo, 'set').mockResolvedValue(undefined);

      await (collector as any).updateStatus('running', '3/5');

      expect(setSpy).toHaveBeenCalledTimes(3); // status + progress + command
      expect(setSpy.mock.calls[0]).toEqual(['versionCheck/status', 'running']);
      expect(setSpy.mock.calls[1]).toEqual(['versionCheck/progress', '3/5']);
      expect(setSpy.mock.calls[2]).toEqual(['versionCheck/command', '']);

      controller.abort();
    });

    it('should skip progress when not provided', async () => {
      const db = createMockDb();
      const controller = new AbortController();
      const collector = new VersionCheckCollector(db as unknown as DatabaseClient, createMockConfig(), controller);

      const setSpy = spyOn((collector as any).settingsRepo, 'set').mockResolvedValue(undefined);

      await (collector as any).updateStatus('idle');

      expect(setSpy).toHaveBeenCalledTimes(2); // status + command (no progress)
      expect(setSpy.mock.calls[0]).toEqual(['versionCheck/status', 'idle']);
      expect(setSpy.mock.calls[1]).toEqual(['versionCheck/command', '']);

      controller.abort();
    });
  });
});
