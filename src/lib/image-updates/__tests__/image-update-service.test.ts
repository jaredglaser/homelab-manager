import { describe, expect, mock, test } from 'bun:test';
import { mockModule } from '@/lib/test/mock-module';
import { jsonResponse, withFetch } from '@/lib/test/fetch-mock';
import type { DockerContainerEventUpsertRow } from '@/lib/database/repositories/docker-container-event-repository';

function containerRow(overrides: Partial<DockerContainerEventUpsertRow>): DockerContainerEventUpsertRow {
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

function mockSnapshot(rows: DockerContainerEventUpsertRow[]): void {
  mockModule<typeof import('@/lib/config/database-config')>('@/lib/config/database-config', (real) => ({
    ...real,
    loadDatabaseConfig: () => ({}),
  }));
  mockModule<typeof import('@/lib/clients/database-client')>('@/lib/clients/database-client', (real) => ({
    ...real,
    databaseConnectionManager: {
      getClient: async () => ({ getPool: () => ({}), close: async () => {} }),
    },
  }));
  mockModule<typeof import('@/lib/database/repositories/docker-container-event-repository')>(
    '@/lib/database/repositories/docker-container-event-repository',
    (real) => ({
      ...real,
      DockerContainerEventRepository: class {
        async getCurrentSnapshot() {
          return rows;
        }
      },
    }),
  );
}

const SOURCE_LABEL = 'org.opencontainers.image.source';

const HUB_PROBE = 'https://registry-1.docker.io/v2/';
const HUB_REALM_HEADER = 'Bearer realm="https://auth.docker.io/token",service="registry.docker.io"';

function mockHubDigestFlow(
  fetchMock: ReturnType<typeof mock>,
  manifestDigest: string,
): void {
  fetchMock.mockImplementation((url) => {
    const target = String(url);
    if (target === HUB_PROBE) {
      return Promise.resolve(new Response(null, { status: 401, headers: { 'WWW-Authenticate': HUB_REALM_HEADER } }));
    }
    if (target.startsWith('https://auth.docker.io/token')) {
      return Promise.resolve(jsonResponse({ token: 'tok' }));
    }
    return Promise.resolve(new Response(null, { status: 200, headers: { 'Docker-Content-Digest': manifestDigest } }));
  });
}

describe('getImageUpdateSummaries', () => {
  test('checks each distinct image once and sorts summaries by image', async () => {
    mockSnapshot([
      containerRow({ containerId: 'a', image: 'redis:7', composeProject: 'web' }),
      containerRow({ containerId: 'b', image: 'redis:7', composeProject: 'web' }),
      containerRow({ containerId: 'c', image: 'traefik:v3.1', composeProject: 'web' }),
      containerRow({ containerId: 'd', image: 'redis:7', composeProject: 'other' }),
      containerRow({ containerId: 'e', image: 'redis:7', host: 'host2', composeProject: 'web' }),
    ]);
    const { restore, fetchMock } = withFetch((url) => {
      const target = String(url);
      if (target.includes('library/redis')) {
        return Promise.resolve(jsonResponse({ results: [{ name: '7' }, { name: '7.4.1' }], next: null }));
      }
      return Promise.resolve(jsonResponse({ results: [{ name: 'v3.1' }, { name: 'v3.2' }], next: null }));
    });
    try {
      const { getImageUpdateSummaries } = await import('../image-update-service');
      const summaries = await getImageUpdateSummaries('web', 'host1');
      expect(summaries.map((s) => s.image)).toEqual(['redis:7', 'traefik:v3.1']);
      const redis = summaries[0];
      expect(redis.updateAvailable).toBe(true);
      expect(redis.latestMatchingTag).toBe('7.4.1');
      expect(fetchMock.mock.calls.length).toBe(2);
    } finally {
      restore();
    }
  });

  test('caches summaries for the stack+host key', async () => {
    mockSnapshot([containerRow({ image: 'redis:7', composeProject: 'cached' })]);
    const { restore, fetchMock } = withFetch(() =>
      Promise.resolve(jsonResponse({ results: [{ name: '7' }, { name: '7.1' }], next: null })),
    );
    try {
      const { getImageUpdateSummaries } = await import('../image-update-service');
      const first = await getImageUpdateSummaries('cached', 'host1');
      const second = await getImageUpdateSummaries('cached', 'host1');
      expect(second).toEqual(first);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      restore();
    }
  });

  test('registry failures stay uncached so the next call retries', async () => {
    mockSnapshot([containerRow({ image: 'app:1.0', composeProject: 'uncached' })]);
    let calls = 0;
    const { restore } = withFetch(() => {
      calls++;
      if (calls === 1) return Promise.reject(new Error('network down'));
      return Promise.resolve(jsonResponse({ results: [{ name: '1.0' }], next: null }));
    });
    try {
      const { getImageUpdateSummaries } = await import('../image-update-service');
      const first = await getImageUpdateSummaries('uncached', 'host1');
      expect(first[0].error).toContain('network down');
      const second = await getImageUpdateSummaries('uncached', 'host1');
      expect(second[0].error).toBeNull();
      expect(second[0].updateAvailable).toBe(false);
      expect(calls).toBe(2);
    } finally {
      restore();
    }
  });

  test('floating-tag docker.io images compare the stored digest through the auth.docker.io realm', async () => {
    mockSnapshot([
      containerRow({ image: 'myapp:latest', imageDigest: 'sha256:' + 'a'.repeat(64), composeProject: 'floating' }),
    ]);
    const { restore, fetchMock } = withFetch(() => Promise.resolve(jsonResponse({})));
    mockHubDigestFlow(fetchMock, 'sha256:' + 'b'.repeat(64));
    try {
      const { getImageUpdateSummaries } = await import('../image-update-service');
      const [summary] = await getImageUpdateSummaries('floating', 'host1');
      expect(summary.updateAvailable).toBe(true);
      const targets = fetchMock.mock.calls.map((call) => String(call[0]));
      expect(targets[0]).toBe(HUB_PROBE);
      expect(targets[1]).toContain('https://auth.docker.io/token');
      expect(targets[2]).toBe('https://registry-1.docker.io/v2/library/myapp/manifests/latest');
      expect(fetchMock.mock.calls.length).toBe(3);
    } finally {
      restore();
    }
  });

  test('prefers a container whose labels carry the source repo', async () => {
    mockSnapshot([
      containerRow({ containerId: 'a', image: 'app:1.0', labels: {}, composeProject: 'labels' }),
      containerRow({ containerId: 'b', image: 'app:1.0', labels: { [SOURCE_LABEL]: 'https://github.com/o/r' }, composeProject: 'labels' }),
    ]);
    const { restore } = withFetch(() => Promise.resolve(jsonResponse({ results: [{ name: '1.0' }], next: null })));
    try {
      const { getImageUpdateSummaries } = await import('../image-update-service');
      const [summary] = await getImageUpdateSummaries('labels', 'host1');
      expect(summary.sourceRepo).toBe('o/r');
    } finally {
      restore();
    }
  });
});

describe('getImageChangelog', () => {
  test('fetches releases from the source repo and caches them', async () => {
    mockSnapshot([containerRow({ image: 'app:1.0', labels: { [SOURCE_LABEL]: 'https://github.com/o/r' }, composeProject: 'changelog-cache' })]);
    const { restore, fetchMock } = withFetch((url) => {
      expect(String(url)).toContain('api.github.com/repos/o/r/releases');
      return Promise.resolve(jsonResponse([
        { tag_name: 'v1.1.0', published_at: '2026-02-01T00:00:00Z', body: 'notes', draft: false },
      ]));
    });
    try {
      const { getImageChangelog } = await import('../image-update-service');
      const first = await getImageChangelog('changelog-cache', 'host1', 'app:1.0');
      expect(first.sourceRepo).toBe('o/r');
      expect(first.releases[0].tagName).toBe('v1.1.0');
      expect(first.error).toBeNull();
      const second = await getImageChangelog('changelog-cache', 'host1', 'app:1.0');
      expect(second).toEqual(first);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      restore();
    }
  });

  test('reports a missing source repo instead of fetching', async () => {
    mockSnapshot([containerRow({ image: 'app:1.0', labels: {}, composeProject: 'changelog-no-repo' })]);
    const { restore, fetchMock } = withFetch(() => Promise.resolve(jsonResponse([])));
    try {
      const { getImageChangelog } = await import('../image-update-service');
      const changelog = await getImageChangelog('changelog-no-repo', 'host1', 'app:1.0');
      expect(changelog.sourceRepo).toBeNull();
      expect(changelog.error).toBe('No GitHub source repository found for this image');
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  test('surfaces GitHub failures as the changelog error', async () => {
    mockSnapshot([containerRow({ image: 'app:1.0', labels: { [SOURCE_LABEL]: 'https://github.com/o/r' }, composeProject: 'changelog-error' })]);
    const { restore } = withFetch(() => Promise.resolve(jsonResponse({}, 404)));
    try {
      const { getImageChangelog } = await import('../image-update-service');
      const changelog = await getImageChangelog('changelog-error', 'host1', 'app:1.0');
      expect(changelog.releases).toEqual([]);
      expect(changelog.error).toBe('No releases are published at github.com/o/r, so there are no release notes to show.');
    } finally {
      restore();
    }
  });
});