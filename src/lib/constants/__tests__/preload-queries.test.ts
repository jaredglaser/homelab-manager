import { describe, expect, it, mock } from 'bun:test';

const dockerCalls: unknown[] = [];
const zfsCalls: unknown[] = [];
const proxmoxCalls: unknown[] = [];

void mock.module('@/data/docker/functions', () => ({
  getHistoricalDockerStats: (arg: unknown) => {
    dockerCalls.push(arg);
    return Promise.resolve([]);
  },
}));
void mock.module('@/data/zfs/functions', () => ({
  getHistoricalZFSStats: (arg: unknown) => {
    zfsCalls.push(arg);
    return Promise.resolve([]);
  },
}));
void mock.module('@/data/proxmox/functions', () => ({
  getHistoricalProxmoxStats: (arg: unknown) => {
    proxmoxCalls.push(arg);
    return Promise.resolve([]);
  },
}));

const {
  DOCKER_SPARKLINE_BUFFER_SECONDS,
  dockerPreloadQueryKey,
  dockerStatsWindowSeconds,
  preloadDockerStats,
  preloadProxmoxStats,
  preloadZFSStats,
} = await import('../preload-queries');

describe('dockerStatsWindowSeconds', () => {
  it('never drops below the sparkline buffer', () => {
    expect(dockerStatsWindowSeconds(10)).toBe(DOCKER_SPARKLINE_BUFFER_SECONDS);
  });

  it('pads a chart window longer than the buffer by 10 seconds', () => {
    expect(dockerStatsWindowSeconds(300)).toBe(310);
  });
});

describe('dockerPreloadQueryKey', () => {
  it('keys each window separately', () => {
    expect(dockerPreloadQueryKey(90)).toEqual(['preload', 'docker-stats', 90]);
    expect(dockerPreloadQueryKey(310)).not.toEqual(dockerPreloadQueryKey(90));
  });
});

describe('preload functions', () => {
  it('request the history window each dashboard opens with', async () => {
    await preloadDockerStats();
    await preloadDockerStats(310);
    await preloadZFSStats();
    await preloadProxmoxStats();

    expect(dockerCalls).toEqual([{ data: { seconds: 90 } }, { data: { seconds: 310 } }]);
    expect(zfsCalls).toEqual([{ data: { seconds: 90 } }]);
    expect(proxmoxCalls).toEqual([{ data: { seconds: 120 } }]);
  });
});
