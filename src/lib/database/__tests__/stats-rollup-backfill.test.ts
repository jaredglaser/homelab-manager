import { describe, test, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import {
  runStatsRollupBackfill,
  STATS_BACKFILL_ADVISORY_LOCK_KEY,
} from '@/lib/database/stats-rollup-backfill';
import type { DatabaseClient } from '@/lib/clients/database-client';

const DAY_MS = 24 * 60 * 60 * 1000;

interface QueryCall {
  text: string;
  values?: unknown[];
}

interface FakeClient {
  calls: QueryCall[];
  releaseCount: number;
  query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
  release(): void;
}

interface FakeOptions {
  minTime?: Date | null;
  rollupsExist?: boolean;
  lockAcquired?: boolean;
  failOn?: (text: string) => boolean;
}

function createFakeClient(options: FakeOptions = {}): FakeClient {
  const {
    minTime = new Date(Date.now() - 5 * DAY_MS),
    rollupsExist = true,
    lockAcquired = true,
    failOn = () => false,
  } = options;

  const client: FakeClient = {
    calls: [],
    releaseCount: 0,
    async query(text: string, values?: unknown[]) {
      client.calls.push({ text, values });
      if (failOn(text)) throw new Error(`boom: ${text}`);
      if (text.includes('pg_try_advisory_lock')) return { rows: [{ acquired: lockAcquired }] };
      if (text.includes('to_regclass')) return { rows: [{ ready: rollupsExist }] };
      if (text.startsWith('SELECT min(time)')) return { rows: [{ min_time: minTime }] };
      return { rows: [] };
    },
    release() {
      client.releaseCount += 1;
    },
  };
  return client;
}

function createFakeDb(client: FakeClient): DatabaseClient {
  return {
    getPool: () => ({ connect: async () => client }),
  } as unknown as DatabaseClient;
}

function texts(client: FakeClient): string[] {
  return client.calls.map((call) => call.text);
}

function refreshCalls(client: FakeClient, view: string): string[] {
  return texts(client).filter((text) =>
    text.startsWith(`CALL refresh_continuous_aggregate('${view}'`),
  );
}

describe('runStatsRollupBackfill', () => {
  let infoSpy: ReturnType<typeof spyOn>;
  let errorSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    infoSpy = spyOn(console, 'info').mockImplementation(() => {});
    errorSpy = spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    infoSpy.mockRestore();
    errorSpy.mockRestore();
  });

  test('backfills from the earliest row, minute tier before hourly tier', async () => {
    const minTime = new Date(Date.UTC(2026, 0, 1, 12, 34, 56, 789));
    const client = createFakeClient({ minTime });

    await runStatsRollupBackfill(createFakeDb(client));

    const minute = refreshCalls(client, 'docker_stats_1m');
    const hour = refreshCalls(client, 'docker_stats_1h');
    expect(minute.length).toBeGreaterThan(1);
    expect(hour.length).toBeGreaterThan(1);

    expect(minute[0]).toContain("'2026-01-01T12:34:00.000Z'::timestamptz");
    expect(hour[0]).toContain("'2026-01-01T12:00:00.000Z'::timestamptz");
    expect(minute[minute.length - 1]).toContain('now()');
    expect(hour[hour.length - 1]).toContain('now()');

    const all = texts(client);
    expect(all.lastIndexOf(minute[minute.length - 1])).toBeLessThan(all.indexOf(hour[0]));
  });

  test('never hardcodes a fixed lookback: a young table gets one window', async () => {
    const client = createFakeClient({ minTime: new Date(Date.now() - 90 * 60 * 1000) });

    await runStatsRollupBackfill(createFakeDb(client));

    expect(refreshCalls(client, 'docker_stats_1m')).toHaveLength(1);
    expect(refreshCalls(client, 'docker_stats_1h')).toHaveLength(1);
  });

  test('sends each refresh as its own statement with no embedded semicolons', async () => {
    const client = createFakeClient();

    await runStatsRollupBackfill(createFakeDb(client));

    const refreshes = texts(client).filter((text) =>
      text.startsWith('CALL refresh_continuous_aggregate'),
    );
    expect(refreshes.length).toBeGreaterThan(0);
    for (const refresh of refreshes) {
      expect(refresh).not.toContain(';');
      expect(refresh).not.toContain('$1');
    }
  });

  test('skips straight to retention when the table is empty', async () => {
    const client = createFakeClient({ minTime: null });

    await runStatsRollupBackfill(createFakeDb(client));

    expect(texts(client).filter((t) => t.startsWith('CALL refresh_continuous_aggregate'))).toEqual(
      [],
    );
    expect(texts(client)).toContain(
      "SELECT add_retention_policy('docker_stats', INTERVAL '24 hours', if_not_exists => TRUE)",
    );
  });

  test('adds retention only after both tiers have been refreshed', async () => {
    const client = createFakeClient();

    await runStatsRollupBackfill(createFakeDb(client));

    for (const table of ['docker_stats', 'zfs_stats', 'proxmox_stats']) {
      const all = texts(client);
      const lastRefresh = all.reduce(
        (found, text, index) =>
          text.startsWith(`CALL refresh_continuous_aggregate('${table}_1h'`) ? index : found,
        -1,
      );
      const minuteRetention = all.indexOf(
        `SELECT add_retention_policy('${table}_1m', INTERVAL '30 days', if_not_exists => TRUE)`,
      );
      const rawRetention = all.indexOf(
        `SELECT add_retention_policy('${table}', INTERVAL '24 hours', if_not_exists => TRUE)`,
      );
      expect(lastRefresh).toBeGreaterThan(-1);
      expect(minuteRetention).toBeGreaterThan(lastRefresh);
      expect(rawRetention).toBeGreaterThan(minuteRetention);
    }
  });

  test('leaves retention unapplied for a source whose refresh failed, and moves on', async () => {
    const client = createFakeClient({
      failOn: (text) => text.startsWith("CALL refresh_continuous_aggregate('zfs_stats_1m'"),
    });

    await runStatsRollupBackfill(createFakeDb(client));

    const all = texts(client);
    expect(all).not.toContain(
      "SELECT add_retention_policy('zfs_stats', INTERVAL '24 hours', if_not_exists => TRUE)",
    );
    expect(all).not.toContain(
      "SELECT add_retention_policy('zfs_stats_1m', INTERVAL '30 days', if_not_exists => TRUE)",
    );
    expect(refreshCalls(client, 'zfs_stats_1h')).toEqual([]);
    expect(all).toContain(
      "SELECT add_retention_policy('proxmox_stats', INTERVAL '24 hours', if_not_exists => TRUE)",
    );
    expect(errorSpy).toHaveBeenCalled();
  });

  test('skips a source whose rollups the migration has not created yet', async () => {
    const client = createFakeClient({ rollupsExist: false });

    await runStatsRollupBackfill(createFakeDb(client));

    const all = texts(client);
    expect(all.filter((t) => t.startsWith('CALL refresh_continuous_aggregate'))).toEqual([]);
    expect(all.filter((t) => t.includes('add_retention_policy'))).toEqual([]);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  test('skips without blocking when another process holds the lock', async () => {
    const client = createFakeClient({ lockAcquired: false });

    await runStatsRollupBackfill(createFakeDb(client));

    expect(texts(client)).toEqual(['SELECT pg_try_advisory_lock($1) AS acquired']);
    expect(client.calls[0].values).toEqual([STATS_BACKFILL_ADVISORY_LOCK_KEY]);
    expect(client.releaseCount).toBe(1);
  });

  test('releases the lock and the connection after a failing source', async () => {
    const client = createFakeClient({ failOn: (text) => text.startsWith('SELECT min(time)') });

    await runStatsRollupBackfill(createFakeDb(client));

    const unlock = client.calls.at(-1);
    expect(unlock?.text).toBe('SELECT pg_advisory_unlock($1)');
    expect(unlock?.values).toEqual([STATS_BACKFILL_ADVISORY_LOCK_KEY]);
    expect(client.releaseCount).toBe(1);
  });

  test('is a no-op on a second run: retention statements stay if_not_exists', async () => {
    const minTime = new Date(Date.UTC(2026, 0, 1));
    const first = createFakeClient({ minTime });
    const second = createFakeClient({ minTime });

    await runStatsRollupBackfill(createFakeDb(first));
    await runStatsRollupBackfill(createFakeDb(second));

    const retention = texts(second).filter((t) => t.includes('add_retention_policy'));
    expect(retention).toHaveLength(6);
    for (const statement of retention) {
      expect(statement).toContain('if_not_exists => TRUE');
    }
  });
});
